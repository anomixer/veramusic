; ==============================================================================
; VERA PSG VRAM Player for Apple II (Pre-loads stream into VERA 128K VRAM)
; Companion to psgstream.asm (Disk version) and psgplay.asm (Apple II RAM version).
;
; On a 140KB 5.25" floppy (Disk II), mid-playback ProDOS MLI disk reads take
; 20-50ms per block, causing audible pauses and stuttering during playback.
;
; SOLUTION:
; At startup, this player opens the PSG stream from the active ProDOS prefix
; and reads it in sequential 512-byte chunks into VERA's 128 KB internal SRAM.
; Once loaded, the floppy drive motor stops completely!
;
; During playback:
;   - Port 0 (VERA_DATA0): Address $00000, Stride +1 (auto-increments in hardware).
;     Reading the next stream byte is just: LDA VERA_DATA0 (4 CPU cycles!).
;   - Port 1 (VERA_DATA1): Address $1F9C0 + reg, Stride 0.
;     Dedicated to writing PSG registers.
;   Because Port 0 and Port 1 maintain independent 17-bit addresses in VERA,
;   PSG register writes NEVER disturb Port 0's stream position!
;
; Controls: ESC/Q = exit, P/M = pause, +,- = master volume, [,] = seek 5s.
; Status: title row 0, controls row 1, "T: mm:ss.s  V: xx" row 23 ($07D0).
; ==============================================================================

* = $2000

MLI         = $BF00
PRODOS_UNIT = $BF30

FILE_BUF = $6000

CNT      = $08
SRC_L    = $06
SRC_H    = $07
SAV_L    = $19
SAV_M    = $1A
SAV_H    = $1B
SAV_CTRL = $1C

START:
    SEI
    CLD                   ; binary mode
    ; Normalize A2Desktop's 80-column/page selection for the PAGE1 UI below.
    LDA #$00
    STA $C002              ; RAMRD main
    STA $C004              ; RAMWRT main
    STA $C000              ; 80STORE off
    STA $C054              ; PAGE1
    STA $C00C              ; 80-column off
    STA $C051              ; TEXT on
    STA $C052              ; MIXED off
    STA $C056              ; HIRES off
    LDA #$00
    STA VERA_IEN
    LDA #$01
    STA VERA_ISR
    STA KBD_STROBE

    JSR SILENCE_ALL
    LDA #15
    STA MASTER_VOL
    LDA #$00
    STA FRM0
    STA FRM1
    STA FRM2
    STA MUTE
    STA ERR
    STA DONE_FLAG
    STA REF_NUM
    STA PRELOAD_CHUNKS
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN

    ; --------------------------------------------------------------------------
    ; 1. Display Pre-load Screen
    ; --------------------------------------------------------------------------
    JSR SHOW_PRELOAD_SCREEN
    JSR OPEN_STREAM
    LDA ERR
    BEQ PRELOAD_OPEN_OK
    JMP DISK_FAIL
PRELOAD_OPEN_OK:

    ; --------------------------------------------------------------------------
    ; 2. Pre-load all blocks into VERA VRAM $00000 via Port 0 (Stride +1)
    ; --------------------------------------------------------------------------
    LDA #$00
    STA VERA_CTRL         ; ADDRSEL = 0 (configure Port 0)
    STA VERA_ADDR_L
    STA VERA_ADDR_M
    LDA #$10              ; Bank 0, Stride +1
    STA VERA_ADDR_H

PRELOAD_LOOP:
    JSR READ_FILE_CHUNK
    LDA ERR
    BEQ PRELOAD_COPY
    JMP DISK_FAIL

PRELOAD_COPY:
    LDA READ_PARAMS+6
    ORA READ_PARAMS+7
    BEQ PRELOAD_DONE
    LDA PRELOAD_CHUNKS
    CMP #248                ; Keep data below VERA's PSG/audio registers.
    BCC PRELOAD_CAP_OK
    LDA #$01
    STA ERR
    JMP DISK_FAIL
PRELOAD_CAP_OK:
    LDA READ_PARAMS+6
    BNE COPY_SHORT_CHUNK
    LDA READ_PARAMS+7
    CMP #$02
    BNE COPY_SHORT_CHUNK
    LDY #$00
COPY_PAGE1:
    LDA $4000,Y
    STA VERA_DATA0
    INY
    BNE COPY_PAGE1

COPY_PAGE2:
    LDA $4100,Y
    STA VERA_DATA0
    INY
    BNE COPY_PAGE2
    JMP PRELOAD_COUNT_CHUNK

COPY_SHORT_CHUNK:
    LDA READ_PARAMS+6
    STA PRELOAD_REMAIN_L
    LDA READ_PARAMS+7
    STA PRELOAD_REMAIN_H
    LDA #<BUF_LO
    STA SRC_L
    LDA #>BUF_LO
    STA SRC_H
    LDY #$00
COPY_SHORT_LOOP:
    LDA (SRC_L),Y
    STA VERA_DATA0
    INC SRC_L
    BNE COPY_SHORT_PTR_OK
    INC SRC_H
COPY_SHORT_PTR_OK:
    LDA PRELOAD_REMAIN_L
    BNE COPY_SHORT_DEC_LO
    DEC PRELOAD_REMAIN_H
COPY_SHORT_DEC_LO:
    DEC PRELOAD_REMAIN_L
    LDA PRELOAD_REMAIN_L
    ORA PRELOAD_REMAIN_H
    BNE COPY_SHORT_LOOP

PRELOAD_COUNT_CHUNK:
    INC PRELOAD_CHUNKS
    JSR UPDATE_PROGRESS_BAR
    JMP PRELOAD_LOOP

PRELOAD_DONE:
    JSR CLOSE_STREAM

    ; --------------------------------------------------------------------------
    ; 3. Setup Port 0 for Stream Playback & Port 1 for PSG writes
    ; --------------------------------------------------------------------------
    ; Reset Port 0 to VRAM $00000, Stride +1
    LDA #$00
    STA VERA_CTRL         ; ADDRSEL = 0 (Port 0)
    STA VERA_ADDR_L
    STA VERA_ADDR_M
    LDA #$10              ; Bank 0, Stride +1
    STA VERA_ADDR_H

    ; Switch to Port 1 (all future VERA_ADDR_L/M/H writes configure Port 1)
    LDA #$01
    STA VERA_CTRL         ; ADDRSEL = 1 (Port 1)

    ; Clear Preload UI & Show Player UI
    JSR SHOW_PLAYER_UI
    JSR IRQ_ON

MAIN:
    LDA DONE_FLAG
    BNE DO_EXIT
    JSR SHOW_STATUS
    LDA ERR
    BEQ MAIN_NO_ERR
    JMP DISK_FAIL
MAIN_NO_ERR:
    LDA KBD_DATA
    BPL MAIN
    STA KBD_STROBE
    AND #$7F
    CMP #$1B              ; ESC
    BEQ DO_EXIT
    CMP #$51              ; 'Q'
    BEQ DO_EXIT
    CMP #$71              ; 'q'
    BEQ DO_EXIT
    CMP #$50              ; 'P'
    BEQ DO_MUTE_JMP
    CMP #$70              ; 'p'
    BEQ DO_MUTE_JMP
    CMP #$4D              ; 'M'
    BEQ DO_MUTE_JMP
    CMP #$6D              ; 'm'
    BEQ DO_MUTE_JMP
    CMP #$2B              ; '+'
    BEQ DO_VOL_UP
    CMP #$3D              ; '='
    BEQ DO_VOL_UP
    CMP #$2D              ; '-'
    BEQ DO_VOL_DOWN
    CMP #$5F              ; '_'
    BEQ DO_VOL_DOWN
    CMP #$5D              ; ']' fast forward 5 sec
    BEQ DO_FF_JMP
    CMP #$7D              ; '}'
    BEQ DO_FF_JMP
    CMP #$5B              ; '[' backward 5 sec
    BEQ DO_RW_JMP
    CMP #$7B              ; '{'
    BEQ DO_RW_JMP
    JMP MAIN

DO_EXIT:
    JMP DO_EXIT_JMP

DO_VOL_UP:
    LDA MASTER_VOL
    CMP #15
    BCS DO_VOL_UP_MAX
    INC MASTER_VOL
    JSR RESTORE_ALL
DO_VOL_UP_MAX:
    JMP MAIN

DO_VOL_DOWN:
    LDA MASTER_VOL
    BEQ DO_VOL_DN_MIN
    DEC MASTER_VOL
    JSR RESTORE_ALL
DO_VOL_DN_MIN:
    JMP MAIN

DO_FF_JMP:
    JMP DO_SEEK_FWD
DO_RW_JMP:
    JMP DO_SEEK_BWD

DO_MUTE_JMP:
    LDA MUTE
    EOR #$01
    STA MUTE
    BNE DO_MUTE_ON
    JSR RESTORE_ALL
    JMP MAIN
DO_MUTE_ON:
    JSR SILENCE_ALL
    JMP MAIN

DO_EXIT_JMP:
    JSR IRQ_OFF
    JSR SILENCE_ALL
    JSR CLOSE_STREAM
    LDA #$00
    STA VERA_CTRL         ; restore Port 0 default
    RTS

DISK_FAIL:
    JSR IRQ_OFF_SAFE
    JSR SILENCE_ALL
    JSR CLOSE_STREAM
    LDA #$00
    STA VERA_CTRL
    LDX #$00
DF_MSG:
    LDA ERRMSG,X
    BEQ DF_WAIT
    ORA #$80
    STA $0750,X           ; row 22
    INX
    BNE DF_MSG
DF_WAIT:
    LDA KBD_DATA
    BPL DF_WAIT
    STA KBD_STROBE
    RTS

; ==============================================================================
; SEEK FORWARD 5 SECONDS (300 FRAMES)
; ==============================================================================
DO_SEEK_FWD:
    SEI
    LDY #<300
    LDA #>300
    STA TARG_H
SF_LOOP_S:
    JSR GETB
    CMP #$FF
    BEQ SF_TERM_S
    CMP #$41
    BCS SF_TERM_S
    STA CNT
    LDA CNT
    BEQ SF_HOLD_S
SF_PAIR_S:
    JSR GETB
    TAX
    JSR GETB
    STA SHADOW,X
    DEC CNT
    BNE SF_PAIR_S
SF_HOLD_S:
    INC FRM0
    BNE SF_F1_S
    INC FRM1
    BNE SF_F1_S
    INC FRM2
SF_F1_S:
    DEY
    BNE SF_LOOP_S
    LDA TARG_H
    BEQ SF_DONE_S
    DEC TARG_H
    LDY #$00
    JMP SF_LOOP_S

SF_TERM_S:
    LDA #$01
    STA DONE_FLAG
    CLI
    JMP MAIN

SF_DONE_S:
    LDA CLK_SEC
    CLC
    ADC #5
    STA CLK_SEC
    CMP #60
    BCC SF_CLK_OK_S
    SBC #60
    STA CLK_SEC
    INC CLK_MIN
SF_CLK_OK_S:
    JSR RESTORE_ALL
    CLI
    JMP MAIN

; ==============================================================================
; SEEK BACKWARD 5 SECONDS (300 FRAMES)
; ==============================================================================
DO_SEEK_BWD:
    SEI
    SEC
    LDA FRM0
    SBC #<300
    STA TARG_L
    LDA FRM1
    SBC #>300
    STA TARG_H
    BCS SB_TARG_OK_S

    LDA #0
    STA TARG_L
    STA TARG_H
SB_TARG_OK_S:
    ; Reset Port 0 to VRAM $00000, Stride +1
    LDA #$00
    STA VERA_CTRL         ; Port 0
    STA VERA_ADDR_L
    STA VERA_ADDR_M
    LDA #$10              ; Bank 0, Stride +1
    STA VERA_ADDR_H
    LDA #$01
    STA VERA_CTRL         ; restore Port 1 for PSG writes

    LDA #0
    STA FRM0
    STA FRM1
    STA FRM2

    ; Clear shadow registers
    LDX #$00
    TXA
SB_CLR_SHADOW_S:
    STA SHADOW,X
    INX
    CPX #$40
    BNE SB_CLR_SHADOW_S

    LDA TARG_L
    ORA TARG_H
    BNE SB_SCAN_S
    JSR SILENCE_ALL
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN
    CLI
    JMP MAIN

SB_SCAN_S:
SB_SCAN_LOOP_S:
    JSR GETB
    CMP #$FF
    BEQ SB_DONE_S
    CMP #$41
    BCS SB_DONE_S
    STA CNT
    LDA CNT
    BEQ SBS_HOLD_S
SBS_PAIR_S:
    JSR GETB
    TAX
    JSR GETB
    STA SHADOW,X
    DEC CNT
    BNE SBS_PAIR_S
SBS_HOLD_S:
    INC FRM0
    BNE SBS_F1_S
    INC FRM1
    BNE SBS_F1_S
    INC FRM2
SBS_F1_S:
    LDA TARG_L
    BNE SBS_D1_S
    DEC TARG_H
SBS_D1_S:
    DEC TARG_L
    LDA TARG_L
    ORA TARG_H
    BNE SB_SCAN_LOOP_S

SB_DONE_S:
    LDA CLK_SEC
    SEC
    SBC #5
    BCS SB_SEC_OK_S
    LDA CLK_MIN
    BEQ SB_MIN_ZERO_S
    DEC CLK_MIN
    LDA CLK_SEC
    CLC
    ADC #55
    JMP SB_SEC_OK_S
SB_MIN_ZERO_S:
    LDA #0
SB_SEC_OK_S:
    STA CLK_SEC
    JSR RESTORE_ALL
    CLI
    JMP MAIN

; ==============================================================================
; IRQ & AUDIO ENGINE
; ==============================================================================
IRQ_ON:
    SEI
    LDA $03FE
    STA OLD_L
    LDA $03FF
    STA OLD_H
    LDA #<IRQ_HANDLER
    STA $03FE
    LDA #>IRQ_HANDLER
    STA $03FF
    LDA #$01
    STA VERA_ISR
    STA VERA_IEN
    CLI
    RTS

IRQ_OFF:
    SEI
    LDA #$00
    STA VERA_IEN
    LDA OLD_L
    STA $03FE
    LDA OLD_H
    STA $03FF
    CLI
    RTS

IRQ_OFF_SAFE:
    SEI
    LDA #$00
    STA VERA_IEN
    CLI
    RTS

IRQ_HANDLER:
    PHA
    TXA
    PHA
    TYA
    PHA
    LDA VERA_ISR
    AND #$01
    BEQ IRQ_DONE
    LDA #$01
    STA VERA_ISR

    ; Save VERA Port 1 address & CTRL
    LDA VERA_CTRL
    STA SAV_CTRL
    LDA VERA_ADDR_L
    STA SAV_L
    LDA VERA_ADDR_M
    STA SAV_M
    LDA VERA_ADDR_H
    STA SAV_H

    JSR TICK

    ; Restore VERA Port 1 address & CTRL
    LDA SAV_CTRL
    STA VERA_CTRL
    LDA SAV_L
    STA VERA_ADDR_L
    LDA SAV_M
    STA VERA_ADDR_M
    LDA SAV_H
    STA VERA_ADDR_H

IRQ_DONE:
    PLA
    TAY
    PLA
    TAX
    PLA
    RTI

; --------------------------------------------------------------------------
; TICK: 60 Hz frame processor
; --------------------------------------------------------------------------
TICK:
    LDA MUTE
    BNE TICK_DONE
    JSR GETB              ; count byte from VRAM Port 0
    CMP #$FF
    BEQ DO_FINISH
    CMP #$41
    BCC TICK_CNT_OK2
    JMP DO_RESTART
TICK_CNT_OK2:
    STA CNT
    LDX CNT
    BEQ TICK_BUMP
PAIR:
    JSR GETB              ; reg
    TAX
    JSR GETB              ; val
    STA SHADOW,X
    TXA
    AND #$03
    CMP #$02
    BNE PAIR_NOSCALE
    LDA SHADOW,X
    JSR SCALE_PSG_REG
    JMP PAIR_SEND
PAIR_NOSCALE:
    LDA SHADOW,X
PAIR_SEND:
    PHA
    TXA
    CLC
    ADC #$C0
    STA VERA_ADDR_L       ; Port 1 Address Low
    LDA #$F9
    ADC #$00
    STA VERA_ADDR_M       ; Port 1 Address Mid ($1F9C0 + reg)
    LDA #$01              ; Bank 1, Stride 0 (Port 1)
    STA VERA_ADDR_H
    PLA
    STA VERA_DATA1        ; Write to PSG via Port 1!
    DEC CNT
    BNE PAIR
TICK_BUMP:
    INC FRM0
    BNE TICK_CLK
    INC FRM1
    BNE TICK_CLK
    INC FRM2
TICK_CLK:
    INC CLK_FRM
    LDA CLK_FRM
    CMP #60
    BCC TICK_DONE
    LDA #$00
    STA CLK_FRM
    INC CLK_SEC
    LDA CLK_SEC
    CMP #60
    BCC TICK_DONE
    LDA #$00
    STA CLK_SEC
    INC CLK_MIN
TICK_DONE:
    RTS

DO_FINISH:
    LDA #$01
    STA DONE_FLAG
    RTS

DO_RESTART:
    ; Reset Port 0 to VRAM $00000, Stride +1
    LDA #$00
    STA VERA_CTRL         ; Port 0
    STA VERA_ADDR_L
    STA VERA_ADDR_M
    LDA #$10              ; Bank 0, Stride +1
    STA VERA_ADDR_H
    LDA #$01
    STA VERA_CTRL         ; Port 1
    LDA #$00
    STA FRM0
    STA FRM1
    STA FRM2
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN
    RTS

; --------------------------------------------------------------------------
; GETB: Fetches next stream byte directly from VERA VRAM via Port 0.
; Hardware auto-increments address by +1. 4 CPU cycles!
; --------------------------------------------------------------------------
GETB:
    LDA VERA_DATA0
    RTS

; ==============================================================================
; HARDWARE AUDIO REGISTERS & SHADOW CONTROL
; ==============================================================================
SILENCE_ALL:
    LDX #$00
SILENCE_LOOP:
    TXA
    CLC
    ADC #$C0
    STA VERA_ADDR_L
    LDA #$F9
    ADC #$00
    STA VERA_ADDR_M
    LDA #$01              ; Bank 1, Stride 0 (Port 1)
    STA VERA_ADDR_H
    LDA #$00
    STA VERA_DATA1
    INX
    CPX #$40
    BNE SILENCE_LOOP
    RTS

RESTORE_ALL:
    LDX #$00
RESTORE_LOOP:
    TXA
    AND #$03
    CMP #$02
    BNE RESTORE_NOSCALE
    LDA SHADOW,X
    JSR SCALE_PSG_REG
    JMP RESTORE_SEND
RESTORE_NOSCALE:
    LDA SHADOW,X
RESTORE_SEND:
    PHA
    TXA
    CLC
    ADC #$C0
    STA VERA_ADDR_L
    LDA #$F9
    ADC #$00
    STA VERA_ADDR_M
    LDA #$01              ; Bank 1, Stride 0 (Port 1)
    STA VERA_ADDR_H
    PLA
    STA VERA_DATA1
    INX
    CPX #$40
    BNE RESTORE_LOOP
    RTS

; A = raw PSG volume/pan register. Scales bits 0..5 by MASTER_VOL (0..15).
SCALE_PSG_REG:
    STX SAV_X
    STY SAV_Y
    PHA                   ; save original A
    LDA MASTER_VOL
    CMP #15
    BCS SPR_FULL
    CMP #0
    BEQ SPR_ZERO

    PLA
    PHA                   ; keep original A saved on stack
    AND #$3F              ; volume 0..63
    STA PROD_V
    LDA #$08              ; +8 for rounding
    STA PROD_L
    LDA #$00
    STA PROD_H
    LDX MASTER_VOL
SPR_ADD:
    CLC
    LDA PROD_L
    ADC PROD_V
    STA PROD_L
    BCC SPR_NOC
    INC PROD_H
SPR_NOC:
    DEX
    BNE SPR_ADD
    LDA PROD_L
    LSR PROD_H
    ROR A
    LSR PROD_H
    ROR A
    LSR PROD_H
    ROR A
    LSR PROD_H
    ROR A
    STA PROD_L
    PLA
    AND #$C0              ; keep Pan bits 7:6
    ORA PROD_L            ; combine with scaled volume
    LDX SAV_X
    LDY SAV_Y
    RTS

SPR_FULL:
    PLA
    LDX SAV_X
    LDY SAV_Y
    RTS

SPR_ZERO:
    PLA
    AND #$C0
    LDX SAV_X
    LDY SAV_Y
    RTS

; ==============================================================================
; ProDOS file calls for allocation-independent preload.
; ==============================================================================
OPEN_STREAM:
    JSR BUILD_FILE_PATH
    BCC OPEN_PATH_OK
    LDA #$40
    STA ERRCODE
    LDA #$01
    STA ERR
    RTS
OPEN_PATH_OK:
    LDA #$03
    STA OPEN_PARAMS
    JSR MLI
    !byte $C8
    !word OPEN_PARAMS
    BCC OPEN_STREAM_OK
    STA ERRCODE
    LDA #$01
    STA ERR
    RTS
OPEN_STREAM_OK:
    LDA OPEN_PARAMS+5
    STA REF_NUM
    RTS

; MLI pathnames need a volume-qualified path when ProDOS has no prefix.
; Preserve a nested active prefix when one exists; otherwise use the boot volume.
BUILD_FILE_PATH:
    LDA #$01
    STA PREFIX_PARAMS
    JSR MLI
    !byte $C7
    !word PREFIX_PARAMS
    BCS BUILD_PATH_FAIL
    LDY PATH_BUF
    BNE BUILD_PATH_PREFIX

    LDA $BF30
    STA ONLINE_PARAMS+1
    JSR MLI
    !byte $C5
    !word ONLINE_PARAMS
    BCS BUILD_PATH_FAIL
    LDA ONLINE_BUF
    AND #$0F
    BEQ BUILD_PATH_FAIL
    STA PATH_LEN
    LDY #$00
    LDA #$2F
    STA PATH_BUF+1,Y
    INY
    LDX #$00
BUILD_PATH_VOLUME:
    LDA ONLINE_BUF+1,X
    STA PATH_BUF+1,Y
    INX
    INY
    CPX PATH_LEN
    BCC BUILD_PATH_VOLUME
    LDA #$2F
    STA PATH_BUF+1,Y
    INY
    TYA
    STA PATH_BUF
    JMP BUILD_PATH_APPEND

BUILD_PATH_PREFIX:
    LDA PATH_BUF,Y
    CMP #$2F
    BEQ BUILD_PATH_APPEND
    INY
    LDA #$2F
    STA PATH_BUF,Y
    TYA
    STA PATH_BUF
BUILD_PATH_APPEND:
    LDY PATH_BUF
    LDX #$00
BUILD_PATH_NAME:
    LDA FILE_NAME,X
    BEQ BUILD_PATH_DONE
    INY
    CPY #$40
    BCS BUILD_PATH_FAIL
    STA PATH_BUF,Y
    INX
    BNE BUILD_PATH_NAME
BUILD_PATH_DONE:
    TYA
    STA PATH_BUF
    CLC
    RTS
BUILD_PATH_FAIL:
    SEC
    RTS

READ_FILE_CHUNK:
    LDA REF_NUM
    STA READ_PARAMS+1
    JSR MLI
    !byte $CA
    !word READ_PARAMS
    BCC READ_FILE_OK
    CMP #$4C            ; EOF is expected after the final partial chunk.
    BEQ READ_FILE_EOF
    STA ERRCODE
    LDA #$01
    STA ERR
    RTS
READ_FILE_OK:
    LDA #$00
    STA ERR
    RTS
READ_FILE_EOF:
    LDA #$00
    STA READ_PARAMS+6
    STA READ_PARAMS+7
    STA ERR
    RTS

CLOSE_STREAM:
    LDA REF_NUM
    BEQ CLOSE_STREAM_DONE
    STA CLOSE_PARAMS+1
    JSR MLI
    !byte $CC
    !word CLOSE_PARAMS
    LDA #$00
    STA REF_NUM
CLOSE_STREAM_DONE:
    RTS

; ==============================================================================
; UI & SCREEN DISPLAY
; ==============================================================================
SHOW_PRELOAD_SCREEN:
    JSR CLEAR_SCREEN
    ; Row 0: Title
    LDX #$00
PL_T0:
    LDA TITLE,X
    BEQ PL_T1
    ORA #$80
    STA $0400,X
    INX
    BNE PL_T0
PL_T1:
    ; Row 1: Loading announcement
    LDX #$00
PL_M1:
    LDA LOAD_MSG,X
    BEQ PL_BAR
    ORA #$80
    STA $0480,X
    INX
    BNE PL_M1
PL_BAR:
    ; Row 12: Progress bar frame [                    ]
    LDA #$DB              ; '['
    STA $0628
    LDA #$DD              ; ']'
    STA $0628 + 39
    RTS

UPDATE_PROGRESS_BAR:
    ; Indeterminate progress marker: one cell per four file chunks.
    LDA PRELOAD_CHUNKS
    LSR A
    LSR A                 ; (blk - 100) / 4 ≈ 0..34
    TAX
    CPX #38
    BCC UP_OK
    LDX #37
UP_OK:
    LDA #$BD              ; '='
    STA $0629,X
    RTS

SHOW_PLAYER_UI:
    ; Row 1: Controls
    LDX #$00
PU_C1:
    LDA TITLE2,X
    BEQ PU_CLEAR_BAR
    ORA #$80
    STA $0480,X
    INX
    BNE PU_C1
PU_CLEAR_BAR:
    ; Clear loading bar lines
    LDX #$00
    LDA #$A0              ; space
PU_CLR:
    STA $0628,X
    INX
    CPX #40
    BNE PU_CLR
    RTS

CLEAR_SCREEN:
    LDX #$00
    LDA #$A0              ; space
CS_LOOP:
    STA $0400,X
    STA $0500,X
    STA $0600,X
    STA $0700,X
    INX
    BNE CS_LOOP
    RTS

SHOW_STATUS:
    ; The loader and A2Desktop may change IIe display banking. Re-select
    ; main-memory 40-column page 1 before drawing the live status row.
    LDA #$00
    STA $C002              ; RAMRD main
    STA $C004              ; RAMWRT main
    STA $C000              ; 80STORE off
    STA $C054              ; PAGE1
    STA $C00C              ; 80-column off
    STA $C051              ; TEXT on
    STA $C052              ; MIXED off
    STA $C056              ; HIRES off

    SEI
    LDA CLK_FRM
    STA DISP_FRM
    LDA CLK_SEC
    STA DISP_SEC
    LDA CLK_MIN
    STA DISP_MIN
    CLI

    ; Row 23 ($07D0): "T: mm:ss.s  V: xx P"
    LDA #$D4              ; 'T'
    STA $07D0
    LDA #$BA              ; ':'
    STA $07D1
    LDA #$A0
    STA $07D2

    ; Minutes
    LDA DISP_MIN
    JSR DIV10_V
    STX $07D3
    ORA #$B0
    STA $07D4

    LDA #$BA              ; ':'
    STA $07D5

    ; Seconds
    LDA DISP_SEC
    JSR DIV10_V
    STX $07D6
    ORA #$B0
    STA $07D7

    LDA #$AE              ; '.'
    STA $07D8

    ; Tenths (DISP_FRM / 6) -> $07D9
    LDA DISP_FRM
    LDX #$B0
DIV6_FRM:
    CMP #6
    BCC DIV6_FRM_DONE
    SEC
    SBC #6
    INX
    BNE DIV6_FRM
DIV6_FRM_DONE:
    TXA
    STA $07D9

    ; 16-channel activity meter: ' [' + 16 chars + ']' at $07DA..$07EC
    ; Each char maps SHADOW[voice*4+2] vol bits (0..63):
    ;   0     -> '.' ($AE)   silent
    ;   1..14 -> '-' ($AD)   quiet
    ;  15..34 -> '=' ($BD)   medium
    ;  35..49 -> '#' ($A3)   loud
    ;  50..63 -> '^' ($DE)   peak
    LDA #$A0              ; ' ' (space between tenths and '[')
    STA $07DA
    LDA #$DB              ; '['
    STA $07DB
    LDY #$02              ; Y = SHADOW offset: ctrl byte of voice 0 (voices: 0,4,8...60)
    LDX #$00              ; X = screen column 0..15
METER_LOOP_V:
    LDA SHADOW,Y
    AND #$3F              ; extract volume bits 5:0
    BEQ METER_DOT_V
    CMP #15
    BCC METER_DASH_V
    CMP #35
    BCC METER_EQ_V
    CMP #50
    BCC METER_HASH_V
    LDA #$DE              ; '^'
    !byte $2C             ; BIT abs (skip next 2 bytes)
METER_HASH_V:
    LDA #$A3              ; '#'
    !byte $2C
METER_EQ_V:
    LDA #$BD              ; '='
    !byte $2C
METER_DASH_V:
    LDA #$AD              ; '-'
    !byte $2C
METER_DOT_V:
    LDA #$AE              ; '.'
METER_PUT_V:
    STA $07DC,X
    INX
    TYA
    CLC
    ADC #$04              ; next voice ctrl offset
    TAY
    CPX #$10              ; 16 voices done?
    BNE METER_LOOP_V
    LDA #$DD              ; ']'
    STA $07EC

    ; Volume: " V:xx" at $07ED..$07F1
    LDA #$A0              ; ' '
    STA $07ED
    LDA #$D6              ; 'V'
    STA $07EE
    LDA #$BA              ; ':'
    STA $07EF

    LDA MASTER_VOL
    JSR DIV10_V
    STX $07F0
    ORA #$B0
    STA $07F1

    ; Pause indicator: " P" at $07F2..$07F3
    LDA #$A0
    STA $07F2
    STA $07F3
    LDA MUTE
    BEQ STATUS_UNMUTED
    LDA #$D0              ; 'P'
    STA $07F3
STATUS_UNMUTED:
    RTS

DIV10_V:
    LDX #$B0
DIV10_VL:
    CMP #10
    BCC DIV10_VD
    SEC
    SBC #10
    INX
    BNE DIV10_VL
DIV10_VD:
    RTS

; ==============================================================================
; DATA & TABLES
; ==============================================================================
TITLE:
    ASC "CHOPIN: FANTAISIE-IMPROMPTU (5:02)      "
    !byte 0
TITLE2:
    ASC "ESC=EXIT P=PAUSE +,-=VOL [,]=SEEK       "
    !byte 0
LOAD_MSG:
    ASC "PRE-LOADING TO VERA 128K VRAM...       "
    !byte 0
ERRMSG:
    ASC "DISK ERR - CANNOT READ STREAM BLOCK"
    !byte 0

SHADOW:
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00

FRM0:       !byte 0
FRM1:       !byte 0
FRM2:       !byte 0
CLK_FRM:    !byte 0
CLK_SEC:    !byte 0
CLK_MIN:    !byte 0
DISP_FRM:   !byte 0
DISP_SEC:   !byte 0
DISP_MIN:   !byte 0
MASTER_VOL: !byte 15
MUTE:       !byte 0
ERR:        !byte 0
DONE_FLAG:  !byte 0
OLD_L:      !byte 0
OLD_H:      !byte 0

TARG_L:     !byte 0
TARG_H:     !byte 0
PRELOAD_CHUNKS: !byte 0
PRELOAD_REMAIN_L: !byte 0
PRELOAD_REMAIN_H: !byte 0

SAV_X:          !byte 0
SAV_Y:          !byte 0
PROD_V:         !byte 0
PROD_L:         !byte 0
PROD_H:         !byte 0

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
    ASC "MUSICFILE.PSG"
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
    !word $4000
    !word $0200
    !word $0000
CLOSE_PARAMS:
    !byte 1,0
REF_NUM: !byte 0
ERRCODE: !byte 0
