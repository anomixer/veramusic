; ==============================================================================
; VERA PCM Disk Stream Player for Apple II (ProDOS MLI Disk Streaming)
;
; Streams 8-bit signed mono PCM audio directly from contiguous ProDOS disk blocks
; into the VERA hardware audio FIFO ($1D).
;
; The PCM stream lives in CONTIGUOUS raw blocks starting at STREAM_BLK0.
; A 512-byte buffer at $4000 is refilled via ProDOS MLI READ_BLOCK ($80).
; The 4KB VERA FIFO absorbs all disk read latency, guaranteeing 100% stutter-free
; streaming playback at up to 22+ kHz.
;
; Controls: ESC / Q = Exit, M = Mute
; Screen: Row 0 Title, Row 1 Info, Row 23 Stopwatch "T: mm:ss.s  B: xxxx"
; Conventions: asm6502.mjs syntax, VERA_BASE injected, $2000 BRUN.
; ==============================================================================

* = $2000

MLI         = $BF00
PRODOS_UNIT = $BF30

STREAM_L = $06       ; pointer into $4000 buffer (zp)
STREAM_H = $07
SAV_L    = $19
SAV_M    = $1A
SAV_H    = $1B

BUF_LO   = $4000     ; 512-byte block buffer
BUF_HI   = $4200

STREAM_BLK0 = 600    ; default start block (overridable at asm time)
TOTAL_BLKS  = 100    ; default total blocks (overridable at asm time)
RATE_VAL    = 21     ; default 8010 Hz (overridable at asm time)

START:
    SEI
    CLD
    LDA #$00
    STA VERA_IEN     ; Disable interrupts
    LDA #$01
    STA VERA_ISR     ; Clear pending IRQ
    STA KBD_STROBE

    ; Bind MLI unit to boot disk
    LDA PRODOS_UNIT
    STA PARAM_UNIT

    ; 1. Reset VERA PCM hardware: format 0 (mono 8-bit), volume 15
    LDA #15
    STA VOLUME
    LDA #$8F         ; Bit 7 = reset FIFO, Format 0, Volume 15
    STA VERA_AUDIO_CTRL
    LDA #$0F         ; Clear reset, Volume 15
    STA VERA_AUDIO_CTRL

    ; Set playback sample rate
    LDA #RATE_VAL
    STA VERA_AUDIO_RATE

    ; 2. Initialize streaming state
    LDA #<STREAM_BLK0
    STA BLK_L
    LDA #>STREAM_BLK0
    STA BLK_H
    LDA #$00
    STA BLK_CNT_L
    STA BLK_CNT_H
    STA PAUSE_FLAG
    STA ERR_FLAG
    STA CLK_FRAC_L
    STA CLK_FRAC_H
    STA CLK_TENTH
    STA CLK_SEC
    STA CLK_MIN

    ; 3. Show title and UI
    JSR SHOW_UI

    ; 4. Pre-fill buffer and VERA FIFO
    JSR REFILL
    LDA ERR_FLAG
    BNE DISK_FAIL_JMP

    ; Pre-load initial blocks into VERA FIFO (up to 4096 bytes)
    JSR PREFILL_FIFO

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
    CLC
    LDA #<STREAM_BLK0
    ADC BLK_CNT_L
    STA BLK_L
    LDA #>STREAM_BLK0
    ADC BLK_CNT_H
    STA BLK_H

    ; Flush VERA PCM FIFO immediately
    LDA VOLUME
    ORA #$80
    STA VERA_AUDIO_CTRL
    LDA VOLUME
    AND #$0F
    STA VERA_AUDIO_CTRL

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
; Pre-fill up to 4 blocks (2048 bytes) into VERA FIFO before starting
; --------------------------------------------------------------------------
PREFILL_FIFO:
    LDX #$04         ; Pre-load 4 blocks
PREFILL_BLK_LOOP:
    JSR FEED_BLOCK_BYTES
    LDA BLK_CNT_L
    CMP #<TOTAL_BLKS
    LDA BLK_CNT_H
    SBC #>TOTAL_BLKS
    BCS PREFILL_DONE
    DEX
    BNE PREFILL_BLK_LOOP
PREFILL_DONE:
    RTS

; --------------------------------------------------------------------------
; Feed bytes from $4000..$41FF into VERA_AUDIO_DATA as long as FIFO not full
; --------------------------------------------------------------------------
FEED_BLOCK_BYTES:
FEED_BYTE_LOOP:
    ; Check if FIFO is full (Bit 7 of VERA_AUDIO_CTRL = 1)
    LDA VERA_AUDIO_CTRL
    BMI FEED_BLOCKED ; Full! Exit loop for now

    ; Check if current 512-byte block buffer is exhausted (STREAM_H == $42)
    LDA STREAM_H
    CMP #>BUF_HI
    BCC SEND_ONE_BYTE

    ; Block finished! Advance sample-accurate block timer ($A39E in 16-bit tenths)
    JSR ADVANCE_BLOCK_TIMER

    ; Current buffer exhausted! Check if reached end of song
    LDA BLK_CNT_L
    CMP #<TOTAL_BLKS
    LDA BLK_CNT_H
    SBC #>TOTAL_BLKS
    BCS STREAM_END

    ; Refill next block from disk!
    JSR REFILL
    LDA ERR_FLAG
    BEQ FEED_NOERR
    JMP DISK_FAIL
FEED_NOERR:
    JMP FEED_BYTE_LOOP

SEND_ONE_BYTE:
    LDY #$00
    LDA (STREAM_L),Y
    STA VERA_AUDIO_DATA

    INC STREAM_L
    BNE FEED_BYTE_LOOP
    INC STREAM_H
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
; ProDOS MLI READ_BLOCK: reads BLK_L/H -> $4000, BLK++, STREAM_PTR=$4000
; --------------------------------------------------------------------------
REFILL:
    PHP
    PHA
    TXA
    PHA
    TYA
    PHA

    LDA BLK_L
    STA PARAM_BLK
    LDA BLK_H
    STA PARAM_BLK+1

    JSR MLI
    !byte $80        ; READ_BLOCK
    !word PARAMS
    BCC REFILL_SUCCESS

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

REFILL_SUCCESS:
    INC BLK_L
    BNE REFILL_NO_CARRY
    INC BLK_H
REFILL_NO_CARRY:
    INC BLK_CNT_L
    BNE REFILL_CNT_OK
    INC BLK_CNT_H
REFILL_CNT_OK:
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
    RTS

DISK_FAIL:
    LDA #$00
    STA VERA_AUDIO_RATE
    LDA #$80
    STA VERA_AUDIO_CTRL
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

    LDA BLK_H
    JSR BYTE_TO_HEX
    STX $07DD
    STA $07DE
    LDA BLK_L
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
PARAMS:
    !byte 3
PARAM_UNIT:
    !byte 0
PARAM_BUF:
    !byte <BUF_LO
    !byte >BUF_LO
PARAM_BLK:
    !byte 0
    !byte 0

; --------------------------------------------------------------------------
; State & Strings
; --------------------------------------------------------------------------
BLK_L:        !byte 0
BLK_H:        !byte 0
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
    ASC "A. NAKARADA: THE WELLERMAN (2:00)       "
    !byte 0
INFO_STR:
    ASC "ESC=EXIT P=PAUSE +,-=VOL [,]=SEEK 8.0K  "
    !byte 0
DISK_ERR_MSG:
    ASC "DISK ERR - STREAM BLOCK UNREADABLE"
    !byte 0
