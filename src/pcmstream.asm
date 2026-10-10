; ==============================================================================
; VERA PCM Disk Stream Player for Apple II (ProDOS MLI Disk Streaming)
;
; Streams 8-bit signed mono PCM audio directly from a ProDOS file into VERA's
; hardware audio FIFO ($1D). Sequential MLI OPEN/READ follows ProDOS allocation.
; The 4KB VERA FIFO absorbs all disk read latency, guaranteeing 100% stutter-free
; streaming playback at up to 22+ kHz.
;
; Controls: ESC / Q = Exit, M = Mute
; Screen: Row 0 Title, Row 1 Info, Row 23 Stopwatch "T: mm:ss.s  B: xxxx"
; Conventions: asm6502.mjs syntax, VERA_BASE injected, $2000 BRUN.
; ==============================================================================

* = $2000

MLI         = $BF00
STREAM_L = $06       ; pointer into $4000 buffer (zp)
STREAM_H = $07
SAV_L    = $19
SAV_M    = $1A
SAV_H    = $1B

BUF_LO   = $4000     ; 512-byte block buffer
BUF_HI   = $4200
FILE_BUF = $6000

TOTAL_BLKS  = 100    ; logical file size bound for seek (overridable at asm time)
RATE_VAL    = 21     ; default 8010 Hz (overridable at asm time)

START:
    SEI
    CLD
    ; A2Desktop leaves the IIe in 80-column/page-2 modes. This player writes
    ; the standard 40-column PAGE1 text page directly, so normalize display
    ; and auxiliary-memory switches before touching the screen or state.
    LDA #$00
    STA $C002            ; RAMRD main
    STA $C004            ; RAMWRT main
    STA $C000            ; 80STORE off
    STA $C054            ; PAGE1
    STA $C00C            ; 80-column off
    STA $C051            ; TEXT on
    STA $C052            ; MIXED off
    STA $C056            ; HIRES off
    LDA #$00
    STA VERA_IEN     ; Disable interrupts
    LDA #$01
    STA VERA_ISR     ; Clear pending IRQ
    STA KBD_STROBE

    LDA #$00
    STA REF_NUM

    ; 1. Reset VERA PCM hardware: format 0 (mono 8-bit), volume 15
    LDA #15
    STA VOLUME
    LDA #$8F         ; Bit 7 = reset FIFO, Format 0, Volume 15
    STA VERA_AUDIO_CTRL
    LDA #$0F         ; Clear reset, Volume 15
    STA VERA_AUDIO_CTRL

    ; Keep playback stopped while the slow SD path fills VERA's FIFO.
    LDA #$00
    STA VERA_AUDIO_RATE

    ; 2. Initialize streaming state
    LDA #$00
    STA BLK_CNT_L
    STA BLK_CNT_H
    STA PAUSE_FLAG
    STA ERR_FLAG
    STA EOF_FLAG
    STA CLK_FRAC_L
    STA CLK_FRAC_H
    STA CLK_TENTH
    STA CLK_SEC
    STA CLK_MIN

    ; 3. Show title and UI
    JSR SHOW_UI
    JSR SHOW_STATUS

    ; 4. Pre-fill buffer and VERA FIFO
    JSR OPEN_STREAM
    LDA ERR_FLAG
    BEQ START_FILE_OK
    JMP DISK_FAIL
START_FILE_OK:
    JSR REFILL
    LDA ERR_FLAG
    BEQ START_READ_OK
    JMP DISK_FAIL
START_READ_OK:

    ; Pre-load initial blocks into VERA FIFO (up to 4096 bytes)
    JSR PREFILL_FIFO
    LDA #RATE_VAL
    STA VERA_AUDIO_RATE

MAIN_LOOP:
    ; 1. Feed available bytes from current block into FIFO (if not paused)
    LDA PAUSE_FLAG
    BNE ML_PAUSED
    JSR FEED_BLOCK_BYTES
ML_PAUSED:

    ; 2. Update status display
    JSR SHOW_STATUS

    ; 3. Check keyboard
    LDA KBD_DATA
    BPL MAIN_LOOP
    STA KBD_STROBE
    AND #$7F

    CMP #$1B         ; ESC
    BEQ DO_EXIT_JMP
    CMP #$51         ; Q
    BEQ DO_EXIT_JMP
    CMP #$71         ; q
    BEQ DO_EXIT_JMP
    CMP #$50         ; P
    BEQ DO_PAUSE_JMP
    CMP #$70         ; p
    BEQ DO_PAUSE_JMP
    CMP #$4D         ; M (alias)
    BEQ DO_PAUSE_JMP
    CMP #$6D         ; m (alias)
    BEQ DO_PAUSE_JMP
    CMP #$2B         ; '+'
    BEQ DO_VOL_UP
    CMP #$3D         ; '='
    BEQ DO_VOL_UP
    CMP #$2D         ; '-'
    BEQ DO_VOL_DOWN
    CMP #$5F         ; '_'
    BEQ DO_VOL_DOWN
    CMP #$5D         ; ']' fast forward 5 sec
    BEQ DO_FF_JMP
    CMP #$7D         ; '}'
    BEQ DO_FF_JMP
    CMP #$5B         ; '[' backward 5 sec
    BEQ DO_RW_JMP
    CMP #$7B         ; '{'
    BEQ DO_RW_JMP

    JMP MAIN_LOOP

DO_VOL_UP:
    LDA VOLUME
    CMP #15
    BCS VOL_DONE
    INC VOLUME
    JSR APPLY_PCM_VOL
    JMP MAIN_LOOP

DO_VOL_DOWN:
    LDA VOLUME
    BEQ VOL_DONE
    DEC VOLUME
    JSR APPLY_PCM_VOL
    JMP MAIN_LOOP

VOL_DONE:
    JMP MAIN_LOOP

DO_EXIT_JMP:
    JMP DO_EXIT
DO_PAUSE_JMP:
    JMP TOGGLE_PAUSE
DISK_FAIL_JMP:
    JMP DISK_FAIL
DO_FF_JMP:
    JMP DO_SEEK_FWD
DO_RW_JMP:
    JMP DO_SEEK_BWD

; --------------------------------------------------------------------------
; Fast forward (]) & Backward ([) 5 seconds (~78 blocks @ 8010 Hz)
; --------------------------------------------------------------------------
DO_SEEK_FWD:
    CLC
    LDA BLK_CNT_L
    ADC #78
    STA BLK_CNT_L
    LDA BLK_CNT_H
    ADC #0
    STA BLK_CNT_H

    LDA BLK_CNT_L
    CMP #<TOTAL_BLKS
    LDA BLK_CNT_H
    SBC #>TOTAL_BLKS
    BCC SF_NOT_END
    JMP STREAM_END

SF_NOT_END:
    CLC
    LDA CLK_SEC
    ADC #5
    CMP #60
    BCC SF_SEC_OK
    SBC #60
    INC CLK_MIN
SF_SEC_OK:
    STA CLK_SEC
    JMP APPLY_PCM_SEEK

DO_SEEK_BWD:
    SEC
    LDA BLK_CNT_L
    SBC #78
    STA BLK_CNT_L
    LDA BLK_CNT_H
    SBC #0
    STA BLK_CNT_H
    BCS SB_NOT_UNDERFLOW

    LDA #0
    STA BLK_CNT_L
    STA BLK_CNT_H
    STA CLK_MIN
    STA CLK_SEC
    STA CLK_TENTH
    STA CLK_FRAC_L
    STA CLK_FRAC_H
    JMP APPLY_PCM_SEEK

SB_NOT_UNDERFLOW:
    LDA CLK_SEC
    SEC
    SBC #5
    BCS SB_SEC_OK
    LDA CLK_MIN
    BEQ SB_CLAMP_MIN
    DEC CLK_MIN
    LDA CLK_SEC
    CLC
    ADC #55          ; CLK_SEC + 60 - 5
    JMP SB_SEC_OK
SB_CLAMP_MIN:
    LDA #0
    STA CLK_MIN
    STA CLK_TENTH
    STA CLK_FRAC_L
    STA CLK_FRAC_H
SB_SEC_OK:
    STA CLK_SEC

APPLY_PCM_SEEK:
    ; Flush VERA PCM FIFO immediately
    LDA VOLUME
    ORA #$80
    STA VERA_AUDIO_CTRL
    LDA VOLUME
    AND #$0F
    STA VERA_AUDIO_CTRL

    LDA #$00
    STA EOF_FLAG
    JSR SET_FILE_MARK
    LDA ERR_FLAG
    BEQ APS_MARK_OK
    JMP DISK_FAIL
APS_MARK_OK:
    JSR REFILL
    LDA ERR_FLAG
    BEQ APS_NOERR
    JMP DISK_FAIL
APS_NOERR:

    LDA PAUSE_FLAG
    BNE APS_DONE
    JSR PREFILL_FIFO
APS_DONE:
    JMP MAIN_LOOP

; --------------------------------------------------------------------------
; Pre-fill up to 8 blocks (4096 bytes) into VERA FIFO before starting
; --------------------------------------------------------------------------
PREFILL_FIFO:
    LDX #$20         ; 32 bounded calls x 128 bytes = 8 blocks
PREFILL_BLK_LOOP:
    JSR FEED_BLOCK_BYTES
    LDA EOF_FLAG
    BNE PREFILL_DONE
    DEX
    BNE PREFILL_BLK_LOOP
PREFILL_DONE:
    RTS

; --------------------------------------------------------------------------
; Feed at most 128 bytes per call. On a slow SD driver, the FIFO may never
; become full, so an unbounded feeder would starve the UI and keyboard loop.
; --------------------------------------------------------------------------
FEED_BLOCK_BYTES:
    LDA #$80
    STA FEED_QUOTA

    ; A complete 128-byte slice can be sent with one end-of-buffer check.
    ; The SD driver leaves little CPU time at 8 kHz, so avoid comparing the
    ; stream pointer to BUF_END for every sample on this common path.
    LDA STREAM_L
    CLC
    ADC #$80
    STA FEED_LIMIT_L
    LDA STREAM_H
    ADC #$00
    CMP BUF_END_H
    BCC FEED_FAST
    BNE FEED_BYTE_LOOP
    LDA FEED_LIMIT_L
    CMP BUF_END_L
    BCC FEED_FAST
    BNE FEED_BYTE_LOOP
FEED_FAST:
    LDY #$00
FEED_FAST_LOOP:
    LDA VERA_AUDIO_CTRL
    BMI FEED_FAST_DONE
    LDA (STREAM_L),Y
    STA VERA_AUDIO_DATA
    INY
    CPY #$80
    BNE FEED_FAST_LOOP
FEED_FAST_DONE:
    TYA
    CLC
    ADC STREAM_L
    STA STREAM_L
    BCC FEED_FAST_RETURN
    INC STREAM_H
FEED_FAST_RETURN:
    RTS
FEED_BYTE_LOOP:
    ; Check if FIFO is full (Bit 7 of VERA_AUDIO_CTRL = 1)
    LDA VERA_AUDIO_CTRL
    BMI FEED_BLOCKED ; Full! Exit loop for now

    ; Check the actual byte count returned by MLI READ (final reads may be short).
    LDA STREAM_H
    CMP BUF_END_H
    BCC SEND_ONE_BYTE
    BNE FEED_BUFFER_DONE
    LDA STREAM_L
    CMP BUF_END_L
    BCC SEND_ONE_BYTE

FEED_BUFFER_DONE:
    LDA EOF_FLAG
    BEQ FEED_ADVANCE_TIMER
    LDA STREAM_L
    CMP #<BUF_LO
    BNE FEED_ADVANCE_TIMER
    LDA STREAM_H
    CMP #>BUF_LO
    BEQ STREAM_END
FEED_ADVANCE_TIMER:
    ; Advance the sample-accurate block timer ($A39E in 16-bit tenths).
    JSR ADVANCE_BLOCK_TIMER

    ; An empty or short read marks the logical end after its bytes are consumed.
    LDA EOF_FLAG
    BNE STREAM_END

    ; Refill next block from disk!
    JSR REFILL
    LDA ERR_FLAG
    BEQ FEED_NOERR
    JMP DISK_FAIL
FEED_NOERR:
    JMP FEED_BLOCK_BYTES   ; new full buffer: use the bounded fast path

SEND_ONE_BYTE:
    LDY #$00
    LDA (STREAM_L),Y
    STA VERA_AUDIO_DATA

    INC STREAM_L
    BNE FEED_SENT
    INC STREAM_H
FEED_SENT:
    DEC FEED_QUOTA
    BEQ FEED_BLOCKED
    JMP FEED_BYTE_LOOP

FEED_BLOCKED:
    RTS

STREAM_END:
    ; Song finished! Wait for hardware FIFO to drain remaining audio before exit
    LDX #$FF
    LDY #$40
DRAIN_FIFO:
    JSR SHOW_STATUS

    ; Check keyboard for early ESC / Q
    LDA KBD_DATA
    BPL DRAIN_NO_KEY
    STA KBD_STROBE
    JMP DRAIN_EXIT

DRAIN_NO_KEY:
    ; Check if VERA audio FIFO is empty (Bit 6 of VERA_AUDIO_CTRL = 1)
    LDA VERA_AUDIO_CTRL
    AND #$40
    BNE DRAIN_EXIT

    ; Fallback timeout counter (~1s)
    DEX
    BNE DRAIN_FIFO
    DEY
    BNE DRAIN_FIFO

DRAIN_EXIT:
    PLA              ; Pop return address of JSR FEED_BLOCK_BYTES
    PLA
    JMP DO_EXIT

; --------------------------------------------------------------------------
; ProDOS sequential file I/O. MLI follows the file's seedling/sapling/tree map.
; --------------------------------------------------------------------------
OPEN_STREAM:
    JSR BUILD_FILE_PATH
    BCC OPEN_PATH_OK
    LDA #$40
    STA ERRCODE
    LDA #$01
    STA ERR_FLAG
    RTS
OPEN_PATH_OK:
    LDA #$03
    STA OPEN_PARAMS
    JSR MLI
    !byte $C8        ; OPEN
    !word OPEN_PARAMS
    BCC OPEN_STREAM_OK
    STA ERRCODE
    LDA #$01
    STA ERR_FLAG
    RTS
OPEN_STREAM_OK:
    LDA OPEN_PARAMS+5
    STA REF_NUM
    RTS

; Resolve the application file under the active prefix. ProDOS can boot with
; an empty prefix, so qualify that case with the boot volume name.
BUILD_FILE_PATH:
    LDA #$01
    STA PREFIX_PARAMS
    JSR MLI
    !byte $C7
    !word PREFIX_PARAMS
    BCC BFP_GOT_PREFIX
    JMP BFP_FAIL
BFP_GOT_PREFIX:
    LDY PATH_BUF
    BNE BFP_PREFIX
    LDA $BF30
    STA ONLINE_PARAMS+1
    JSR MLI
    !byte $C5
    !word ONLINE_PARAMS
    BCC BFP_ONLINE_OK
    JMP BFP_FAIL
BFP_ONLINE_OK:
    LDA ONLINE_BUF
    AND #$0F
    BEQ BFP_FAIL
    STA PATH_LEN
    LDY #$00
    LDA #$2F
    STA PATH_BUF+1,Y
    INY
    LDX #$00
BFP_VOL_LOOP:
    LDA ONLINE_BUF+1,X
    STA PATH_BUF+1,Y
    INX
    INY
    CPX PATH_LEN
    BCC BFP_VOL_LOOP
    LDA #$2F
    STA PATH_BUF+1,Y
    INY
    TYA
    STA PATH_BUF
    JMP BFP_APPEND
BFP_PREFIX:
    LDA PATH_BUF,Y
    CMP #$2F
    BEQ BFP_APPEND
    INY
    LDA #$2F
    STA PATH_BUF,Y
    TYA
    STA PATH_BUF
BFP_APPEND:
    LDY PATH_BUF
    LDX #$00
BFP_NAME_LOOP:
    LDA FILE_NAME,X
    BEQ BFP_DONE
    INY
    CPY #$40
    BCS BFP_FAIL
    STA PATH_BUF,Y
    INX
    BNE BFP_NAME_LOOP
BFP_DONE:
    TYA
    STA PATH_BUF
    CLC
    RTS
BFP_FAIL:
    SEC
    RTS

CLOSE_STREAM:
    LDA REF_NUM
    BEQ CLOSE_STREAM_DONE
    STA CLOSE_PARAMS+1
    JSR MLI
    !byte $CC        ; CLOSE
    !word CLOSE_PARAMS
    LDA #$00
    STA REF_NUM
CLOSE_STREAM_DONE:
    RTS

SET_FILE_MARK:
    LDA REF_NUM
    STA SETMARK_PARAMS+1
    LDA #$00
    STA SETMARK_PARAMS+2
    LDA BLK_CNT_L
    ASL A
    STA SETMARK_PARAMS+3
    LDA BLK_CNT_H
    ROL A
    STA SETMARK_PARAMS+4
    JSR MLI
    !byte $CE        ; SET_MARK
    !word SETMARK_PARAMS
    BCC SET_FILE_MARK_OK
    STA ERRCODE
    LDA #$01
    STA ERR_FLAG
SET_FILE_MARK_OK:
    RTS

; Read up to 512 bytes. Track the actual end pointer; a short or empty read is EOF.
; --------------------------------------------------------------------------
REFILL:
    PHP
    PHA
    TXA
    PHA
    TYA
    PHA

    LDA REF_NUM
    STA READ_PARAMS+1

    JSR MLI
    !byte $CA        ; READ
    !word READ_PARAMS
    BCC REFILL_SUCCESS
    CMP #$4C            ; EOF is normal; trans_count is zero
    BEQ REFILL_EOF
    STA ERRCODE
    LDA #$01
    STA ERR_FLAG
    PLA
    TAY
    PLA
    TAX
    PLA
    PLP
    RTS

REFILL_EOF:
    LDA #$01
    STA EOF_FLAG
    LDA #<BUF_LO
    STA BUF_END_L
    LDA #>BUF_LO
    STA BUF_END_H
    JMP REFILL_SET_PTR

REFILL_SUCCESS:
    LDA READ_PARAMS+6
    ORA READ_PARAMS+7
    BNE REFILL_DATA
    LDA #$01
    STA EOF_FLAG
    JMP REFILL_EMPTY
REFILL_DATA:
    INC BLK_CNT_L
    BNE REFILL_CNT_OK
    INC BLK_CNT_H
REFILL_CNT_OK:
    ; Actual end pointer = $4000 + returned byte count.
    LDA READ_PARAMS+6
    CLC
    ADC #<BUF_LO
    STA BUF_END_L
    LDA READ_PARAMS+7
    ADC #>BUF_LO
    STA BUF_END_H
    LDA READ_PARAMS+6
    CMP #$00
    BNE REFILL_MARK_SHORT
    LDA READ_PARAMS+7
    CMP #$02
    BEQ REFILL_SET_PTR
REFILL_MARK_SHORT:
    LDA #$01
    STA EOF_FLAG
    JMP REFILL_SET_PTR
REFILL_EMPTY:
    LDA #<BUF_LO
    STA BUF_END_L
    LDA #>BUF_LO
    STA BUF_END_H
REFILL_SET_PTR:
    LDA #<BUF_LO
    STA STREAM_L
    LDA #>BUF_LO
    STA STREAM_H

    PLA
    TAY
    PLA
    TAX
    PLA
    PLP
    RTS

; --------------------------------------------------------------------------
; Pause / Resume
; --------------------------------------------------------------------------
TOGGLE_PAUSE:
    LDA PAUSE_FLAG
    BNE DO_RESUME
    LDA #$01
    STA PAUSE_FLAG
    LDA #$00
    STA VERA_AUDIO_RATE   ; Freeze audio sample clock
    STA VERA_AUDIO_CTRL   ; Silence volume
    JMP MAIN_LOOP

DO_RESUME:
    LDA #$00
    STA PAUSE_FLAG
    LDA #RATE_VAL
    STA VERA_AUDIO_RATE   ; Resume audio sample clock
    JSR APPLY_PCM_VOL     ; Restore current volume
    JMP MAIN_LOOP

APPLY_PCM_VOL:
    LDA PAUSE_FLAG
    BNE APV_PAUSED        ; If paused, keep volume 0
    LDA VOLUME
    AND #$0F              ; Ensure bit 7 is 0 so FIFO is never flushed!
    STA VERA_AUDIO_CTRL
APV_PAUSED:
    RTS

; --------------------------------------------------------------------------
; Exit & Cleanup
; --------------------------------------------------------------------------
DO_EXIT:
    LDA #$00
    STA VERA_AUDIO_RATE   ; Stop audio clock
    LDA #$80
    STA VERA_AUDIO_CTRL   ; Reset FIFO / silence
    JSR CLOSE_STREAM
    RTS

DISK_FAIL:
    LDA #$00
    STA VERA_AUDIO_RATE
    LDA #$80
    STA VERA_AUDIO_CTRL
    JSR CLOSE_STREAM
    ; Print "DISK ERR" at $06D0 (row 22)
    LDY #$00
DF_LOOP:
    LDA DISK_ERR_MSG,Y
    BEQ DF_DONE
    ORA #$80
    STA $06D0,Y
    INY
    BNE DF_LOOP
DF_DONE:
    LDA #$A0
    STA $06F2
    LDA #$A4
    STA $06F3
    LDA ERRCODE
    JSR BYTE_TO_HEX
    STX $06F4
    STA $06F5
    RTS

; --------------------------------------------------------------------------
; Advance sample-accurate block timer:
; Each 512-byte block @ 8010.864 Hz = 0.063913269 s = 0.63913269 tenths.
; In 16-bit fixed point: 0.63913269 * 65536 = 41886 ($A39E).
; --------------------------------------------------------------------------
ADVANCE_BLOCK_TIMER:
    CLC
    LDA CLK_FRAC_L
    ADC #$9E
    STA CLK_FRAC_L
    LDA CLK_FRAC_H
    ADC #$A3
    STA CLK_FRAC_H
    BCC ABT_DONE

    INC CLK_TENTH
    LDA CLK_TENTH
    CMP #10
    BCC ABT_DONE
    LDA #$00
    STA CLK_TENTH

    INC CLK_SEC
    LDA CLK_SEC
    CMP #60
    BCC ABT_DONE
    LDA #$00
    STA CLK_SEC

    INC CLK_MIN
ABT_DONE:
    RTS

SHOW_UI:
    ; Row 0 Title
    LDY #$00
SUI_T:
    LDA TITLE_STR,Y
    BEQ SUI_T_END
    ORA #$80
    STA $0400,Y
    INY
    CPY #40
    BNE SUI_T
SUI_T_END:

    ; Row 1 Info
    LDY #$00
SUI_R1:
    LDA INFO_STR,Y
    BEQ SUI_R1_END
    ORA #$80
    STA $0480,Y
    INY
    CPY #40
    BNE SUI_R1
SUI_R1_END:
    RTS

SHOW_STATUS:
    ; ProDOS/SD drivers and A2Desktop may change the IIe display banking
    ; after file I/O. Re-select main-memory 40-column page 1 before drawing.
    LDA #$00
    STA $C002            ; RAMRD main
    STA $C004            ; RAMWRT main
    STA $C000            ; 80STORE off
    STA $C054            ; PAGE1
    STA $C00C            ; 80-column off
    STA $C051            ; TEXT on
    STA $C052            ; MIXED off
    STA $C056            ; HIRES off

    ; Row 23 ($07D0): "T: mm:ss.s B:xxxx  M"
    LDA #$D4              ; 'T'
    STA $07D0
    LDA #$BA              ; ':'
    STA $07D1
    LDA #$A0              ; ' '
    STA $07D2

    LDA CLK_MIN
    JSR HEX_TO_DEC
    STA $07D3
    TXA
    STA $07D4

    LDA #$BA              ; ':'
    STA $07D5

    LDA CLK_SEC
    JSR HEX_TO_DEC
    STA $07D6
    TXA
    STA $07D7

    LDA #$AE              ; '.'
    STA $07D8

    LDA CLK_TENTH
    ORA #$B0
    STA $07D9

    LDA #$A0              ; ' '
    STA $07DA
    LDA #$C2              ; 'B'
    STA $07DB
    LDA #$BA              ; ':'
    STA $07DC

    LDA BLK_CNT_H
    JSR BYTE_TO_HEX
    STX $07DD
    STA $07DE
    LDA BLK_CNT_L
    JSR BYTE_TO_HEX
    STX $07DF
    STA $07E0

    ; Volume indicator: " V:xx" at $07E1..$07E5
    LDA #$A0              ; ' '
    STA $07E1
    LDA #$D6              ; 'V'
    STA $07E2
    LDA #$BA              ; ':'
    STA $07E3
    LDA VOLUME
    JSR HEX_TO_DEC
    STA $07E4             ; Tens digit ('0' or '1')
    TXA
    STA $07E5             ; Units digit ('0'..'9')

    ; Pause indicator: " P" at $07E6..$07E7
    LDA #$A0
    STA $07E6
    STA $07E7
    LDA PAUSE_FLAG
    BEQ NO_PAUSED
    LDA #$D0              ; 'P'
    STA $07E7
NO_PAUSED:
    ; Blank padding for columns 24..39 ($07E8..$07F7)
    LDA #$A0
    LDX #$00
CLR_TAIL_PCM:
    STA $07E8,X
    INX
    CPX #$10
    BNE CLR_TAIL_PCM
    RTS

HEX_TO_DEC:
    LDX #$B0
H2D_LOOP:
    CMP #10
    BCC H2D_DONE
    SBC #10
    INX
    BNE H2D_LOOP
H2D_DONE:
    ORA #$B0
    PHA
    TXA
    TAY
    PLA
    TAX
    TYA
    RTS

BYTE_TO_HEX:
    PHA
    LSR A
    LSR A
    LSR A
    LSR A
    JSR NIB_HEX
    TAX
    PLA
    AND #$0F
    JSR NIB_HEX
    RTS
NIB_HEX:
    CMP #$0A
    BCC NIB_NUM
    ADC #$36
    ORA #$80
    RTS
NIB_NUM:
    ORA #$B0
    RTS

; --------------------------------------------------------------------------
; ProDOS MLI Parameter Table
; --------------------------------------------------------------------------
PATH_BUF:
    !byte 0
    !byte $FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF
    !byte $FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF
    !byte $FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF
    !byte $FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF
PATH_LEN: !byte $FF
FILE_NAME_LEN:
    !byte 13
FILE_NAME:
    ASC "MUSICFILE.PCM"
    !byte 0
PREFIX_PARAMS:
    !byte 1
    !word PATH_BUF
ONLINE_PARAMS:
    !byte 2,0
    !word ONLINE_BUF
ONLINE_BUF:
    !byte $FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF
OPEN_PARAMS:
    !byte 3
    !word PATH_BUF
    !word FILE_BUF
    !byte 0
READ_PARAMS:
    !byte 4
    !byte 0
    !word BUF_LO
    !word $0200
    !word $0000
CLOSE_PARAMS:
    !byte 1,0
SETMARK_PARAMS:
    !byte 2,0,0,0,0
REF_NUM:        !byte 0
EOF_FLAG:       !byte 0
BUF_END_L:      !byte 0
BUF_END_H:      !byte 0
FEED_QUOTA:     !byte 0
FEED_LIMIT_L:   !byte 0

; --------------------------------------------------------------------------
; State & Strings
; --------------------------------------------------------------------------
BLK_CNT_L:    !byte 0
BLK_CNT_H:    !byte 0
PAUSE_FLAG:   !byte 0
VOLUME:       !byte 15
ERR_FLAG:     !byte 0
ERRCODE:      !byte 0
CLK_FRAC_L:   !byte 0
CLK_FRAC_H:   !byte 0
CLK_TENTH:    !byte 0
CLK_SEC:      !byte 0
CLK_MIN:      !byte 0

TITLE_STR:
    ASC "A. NAKARADA: THE WELLERMAN (2:00) SD4   "
    !byte 0
INFO_STR:
    ASC "ESC=EXIT P=PAUSE +,-=VOL [,]=SEEK 8.0K  "
    !byte 0
DISK_ERR_MSG:
    ASC "DISK ERR - STREAM BLOCK UNREADABLE"
    !byte 0
