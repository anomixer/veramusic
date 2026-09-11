; ==============================================================================
; VERA Hybrid Stream Player for Apple II (Option A: PSG Synth + PCM Drums)
;
; Driven by 60Hz VERA VSYNC IRQ ($03FE hook, identical to psgstream.asm):
; - Ticks 16-channel VERA PSG registers ($1F9C0..$1F9FF) with master volume scaling
; - Feeds 8.0 kHz 8-bit signed PCM drum audio directly to VERA FIFO ($1D)
; - Refills 512-byte buffer at $4000 via ProDOS MLI READ_BLOCK ($80)
; - Prefilled with 4 frames (~66ms) of PCM audio for 100% stutter-free playback
;
; Controls:
;   + / = : Volume Up (PCM hardware + PSG shadow scaling)
;   - / _ : Volume Down
;   P / M : Pause / Resume
;   ESC/Q : Exit to Menu
;
; Screen: Row 0 Title, Row 1 Info, Row 23 "T: mm:ss.s  V: xx  B: xxxx"
; Conventions: asm6502.mjs syntax, VERA_BASE injected, $2000 BRUN.
; ==============================================================================

* = $2000

MLI         = $BF00
PRODOS_UNIT = $BF30

STREAM_L = $06       ; feeder pointer into $4000 buffer (zp)
STREAM_H = $07
CNT      = $08
SAV_L    = $19
SAV_M    = $1A
SAV_H    = $1B

BUF_LO   = $4000     ; 512-byte block buffer
BUF_HI   = $4200     ; $4000 + $200

STREAM_BLK0 = 5000   ; default start block (overridden by build_jukebox.mjs)
RATE_VAL    = 21     ; 8010.864 Hz

START:
    SEI
    CLD
    LDA #$00
    STA VERA_IEN
    LDA #$01
    STA VERA_ISR
    STA KBD_STROBE

    JSR SILENCE_ALL
    LDA PRODOS_UNIT
    STA PARAM_UNIT

    ; Reset VERA PCM hardware: format 0 (mono 8-bit), volume 15
    LDA #15
    STA MASTER_VOL
    LDA #$8F         ; Reset FIFO, Format 0, Volume 15
    STA VERA_AUDIO_CTRL
    LDA #$0F         ; Clear reset, Volume 15
    STA VERA_AUDIO_CTRL
    LDA #$00
    STA VERA_AUDIO_RATE ; Keep audio stopped during prefill

    ; Initialize state variables
    LDA #<STREAM_BLK0
    STA BLK_L
    LDA #>STREAM_BLK0
    STA BLK_H
    LDA #$00
    STA PAUSE_FLAG
    STA ERR
    STA DONE_FLAG
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN

    ; 1. Load first block from disk synchronously before hooking IRQ
    JSR REFILL_MAIN
    LDA ERR
    BEQ PREFILL_START
    JSR SHOW_TITLE
    JMP DISK_FAIL

PREFILL_START:
    ; 2. Read prefill PCM header (u16 LE bytes) and push into VERA FIFO
    JSR GETB
    STA PREFILL_L
    JSR GETB
    STA PREFILL_H

PREFILL_LOOP:
    LDA PREFILL_L
    ORA PREFILL_H
    BEQ PREFILL_DONE
    JSR GETB
    STA VERA_AUDIO_DATA
    LDA PREFILL_L
    BNE PF_DEC
    DEC PREFILL_H
PF_DEC:
    DEC PREFILL_L
    JMP PREFILL_LOOP

PREFILL_DONE:
    ; 3. Show title screen and initial UI
    JSR SHOW_TITLE

    ; 4. Start PCM playback hardware clock!
    LDA #RATE_VAL
    STA VERA_AUDIO_RATE

    ; 5. Hook 60Hz VSYNC IRQ and start playing!
    JSR IRQ_ON

MAIN:
    LDA DIRTY_UI
    BEQ MAIN_NO_UI
    LDA #$00
    STA DIRTY_UI
    JSR SHOW_STATUS

MAIN_NO_UI:
    LDA DONE_FLAG
    BNE DO_EXIT_JMP
    LDA ERR
    BNE DISK_FAIL_JMP

    LDA KBD_DATA
    BPL MAIN
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
    JMP MAIN

DO_VOL_UP:
    LDA MASTER_VOL
    CMP #15
    BCS MAIN
    INC MASTER_VOL
    JSR APPLY_ALL_VOL
    JMP MAIN

DO_VOL_DOWN:
    LDA MASTER_VOL
    BEQ MAIN
    DEC MASTER_VOL
    JSR APPLY_ALL_VOL
    JMP MAIN

DO_EXIT_JMP:
    JMP DO_EXIT
DO_PAUSE_JMP:
    JMP DO_PAUSE
DISK_FAIL_JMP:
    JMP DISK_FAIL

; --------------------------------------------------------------------------
; IRQ Setup and Handler
; --------------------------------------------------------------------------
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
    LDA VERA_ADDR_L
    STA SAV_L
    LDA VERA_ADDR_M
    STA SAV_M
    LDA VERA_ADDR_H
    STA SAV_H

    JSR TICK

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
; TICK: Runs once per 60Hz VSYNC frame inside IRQ
; --------------------------------------------------------------------------
TICK:
    LDA PAUSE_FLAG
    BEQ TICK_RUN
    RTS

TICK_RUN:

    ; 1. Read PSG event count for current frame
    JSR GETB
    CMP #$FF              ; $FF = End of Song
    BEQ TICK_EOF
    STA CNT
    LDX CNT
    BEQ TICK_DO_PCM       ; Count 0 = no PSG register changes

TICK_PSG_LOOP:
    JSR GETB              ; reg (0..63)
    TAX
    JSR GETB              ; val
    STA SHADOW,X          ; Store unscaled value in shadow table

    TXA
    AND #$03
    CMP #$02              ; Is it a volume register? (+2)
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
    ADC #$C0              ; VRAM $1F9C0 + reg (low)
    STA VERA_ADDR_L
    LDA #$F9
    ADC #$00              ; carry (high)
    STA VERA_ADDR_M
    LDA #$11              ; Bank 1, stride +1
    STA VERA_ADDR_H
    PLA
    STA VERA_DATA0

    DEC CNT
    BNE TICK_PSG_LOOP

TICK_DO_PCM:
    ; 2. Read PCM sample count for current frame
    JSR GETB
    STA PCM_CNT
    LDX PCM_CNT
    BEQ TICK_ADV_CLK

TICK_PCM_LOOP:
    JSR GETB
    STA VERA_AUDIO_DATA
    DEX
    BNE TICK_PCM_LOOP

TICK_ADV_CLK:
    LDA #$01
    STA DIRTY_UI

    ; 3. Advance stopwatch
    INC CLK_FRM
    LDA CLK_FRM
    CMP #60
    BCC TICK_DONE
    LDA #0
    STA CLK_FRM
    INC CLK_SEC
    LDA CLK_SEC
    CMP #60
    BCC TICK_DONE
    LDA #0
    STA CLK_SEC
    INC CLK_MIN

TICK_DONE:
    RTS

TICK_EOF:
    LDA #$01
    STA DONE_FLAG
    RTS

; --------------------------------------------------------------------------
; Feeder: Read next byte from $4000 block buffer, auto-refilling at $41FF
; --------------------------------------------------------------------------
GETB:
    LDA STREAM_H
    CMP #>BUF_HI          ; >= $42 ?
    BCC GETB_READY
    JSR REFILL
GETB_READY:
    LDY #$00
    LDA (STREAM_L),Y
    PHA
    INC STREAM_L
    BNE GETB_OK
    INC STREAM_H
GETB_OK:
    PLA
    RTS

; --------------------------------------------------------------------------
; REFILL: Read BLK_L/H -> $4000, BLK++, STREAM_PTR = $4000. Preserves all regs.
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
    !byte $80
    !word PARAMS
    BCC REFILL_OK

    STA ERRCODE
    LDA #$01
    STA ERR
    PLA
    TAY
    PLA
    TAX
    PLA
    PLP
    RTS

REFILL_OK:
    INC BLK_L
    BNE REFILL_NOCARRY
    INC BLK_H
REFILL_NOCARRY:
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

REFILL_MAIN:
    LDA #<STREAM_BLK0
    STA BLK_L
    LDA #>STREAM_BLK0
    STA BLK_H
    JSR REFILL
    RTS

; --------------------------------------------------------------------------
; Volume and Mute Handlers
; --------------------------------------------------------------------------
APPLY_ALL_VOL:
    SEI
    LDA MASTER_VOL
    STA VERA_AUDIO_CTRL   ; Hardware PCM volume (0..15)
    LDA PAUSE_FLAG
    BNE APV_DONE
    JSR RESTORE_ALL       ; Update active PSG voice registers
APV_DONE:
    CLI
    RTS

DO_PAUSE:
    SEI
    LDA PAUSE_FLAG
    BNE UNPAUSE
    LDA #$01
    STA PAUSE_FLAG
    LDA #$00
    STA VERA_AUDIO_RATE   ; Pause PCM playback clock (FIFO preserved)
    JSR SILENCE_ALL       ; Silence PSG
    CLI
    JMP MAIN

UNPAUSE:
    LDA #$00
    STA PAUSE_FLAG
    JSR RESTORE_ALL       ; Restore PSG registers
    LDA #RATE_VAL
    STA VERA_AUDIO_RATE   ; Resume PCM clock
    CLI
    JMP MAIN

DO_EXIT:
    JSR IRQ_OFF
    LDA #$00
    STA VERA_AUDIO_RATE   ; Stop PCM
    LDA #$8F              ; Reset PCM FIFO
    STA VERA_AUDIO_CTRL
    LDA #$0F
    STA VERA_AUDIO_CTRL
    JSR SILENCE_ALL       ; Silence PSG
    CLI
    RTS

; Scale PSG volume (bits 5..0) by MASTER_VOL (0..15)
SCALE_PSG_REG:
    STX SAV_X
    STY SAV_Y
    PHA
    LDA MASTER_VOL
    CMP #15
    BCS SPR_FULL
    CMP #0
    BEQ SPR_ZERO

    PLA
    PHA
    AND #$3F
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
    AND #$C0              ; Preserver Pan bits
    ORA PROD_L
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

SILENCE_ALL:
    LDX #0
SIL_LOOP:
    TXA
    CLC
    ADC #$C0
    STA VERA_ADDR_L
    LDA #$F9
    ADC #$00
    STA VERA_ADDR_M
    LDA #$11
    STA VERA_ADDR_H
    LDA #0
    STA VERA_DATA0
    INX
    CPX #64
    BNE SIL_LOOP
    RTS

RESTORE_ALL:
    LDX #0
RA_LOOP:
    TXA
    CLC
    ADC #$C0
    STA VERA_ADDR_L
    LDA #$F9
    ADC #$00
    STA VERA_ADDR_M
    LDA #$11
    STA VERA_ADDR_H
    TXA
    AND #$03
    CMP #$02
    BNE RA_RAW
    LDA SHADOW,X
    JSR SCALE_PSG_REG
    JMP RA_SEND
RA_RAW:
    LDA SHADOW,X
RA_SEND:
    STA VERA_DATA0
    INX
    CPX #64
    BNE RA_LOOP
    RTS

; --------------------------------------------------------------------------
; UI Screen Display
; --------------------------------------------------------------------------
SHOW_TITLE:
    LDY #39
CLEAR_UI:
    LDA #$A0
    STA $0400,Y
    STA $0480,Y
    STA $07D0,Y
    DEY
    BPL CLEAR_UI

    LDY #0
T_LOOP:
    LDA TITLE_STR,Y
    BEQ T_SUB
    ORA #$80
    STA $0400,Y
    INY
    BNE T_LOOP
T_SUB:
    LDY #0
S_LOOP:
    LDA SUB_STR,Y
    BEQ S_DONE
    ORA #$80
    STA $0480,Y
    INY
    BNE S_LOOP
S_DONE:
    RTS

TITLE_STR:
    ASC "CAPTAIN: SPACE DEBRIS (HYBRID PSG+PCM)  "
    !byte 0
SUB_STR:
    ASC "ESC/Q=EXIT  P=PAUSE  +/-=VOL HYBRID     "
    !byte 0

SHOW_STATUS:
    SEI
    LDA CLK_FRM
    STA DISP_FRM
    LDA CLK_SEC
    STA DISP_SEC
    LDA CLK_MIN
    STA DISP_MIN
    LDA BLK_H
    STA DISP_BLK_H
    LDA BLK_L
    STA DISP_BLK_L
    CLI

    ; Row 23: "T: mm:ss.s  V: xx  B: xxxx"
    ; "T: "
    LDA #$D4 ; 'T'
    STA $07D0
    LDA #$BA ; ':'
    STA $07D1
    LDA #$A0 ; ' '
    STA $07D2

    ; mm
    LDA DISP_MIN
    JSR PUT_DEC2
    STA $07D3
    STX $07D4

    LDA #$BA ; ':'
    STA $07D5

    ; ss
    LDA DISP_SEC
    JSR PUT_DEC2
    STA $07D6
    STX $07D7

    LDA #$AE ; '.'
    STA $07D8

    ; s (tenth) — calculated from DISP_FRM / 6
    LDA DISP_FRM
    LDX #0
TENTH_CALC:
    CMP #6
    BCC TENTH_DONE
    SBC #6
    INX
    BNE TENTH_CALC
TENTH_DONE:
    TXA
    CLC
    ADC #$B0
    STA $07D9

    ; "  V: "
    LDA #$A0
    STA $07DA
    LDA #$D6 ; 'V'
    STA $07DB
    LDA #$BA ; ':'
    STA $07DC

    ; Volume xx
    LDA MASTER_VOL
    JSR PUT_DEC2
    STA $07DD
    STX $07DE

    ; "  B: "
    LDA #$A0
    STA $07DF
    STA $07E0
    LDA #$C2 ; 'B'
    STA $07E1
    LDA #$BA ; ':'
    STA $07E2

    ; Block number (hex)
    LDA DISP_BLK_H
    JSR PUT_HEX2
    STA $07E3
    STX $07E4
    LDA DISP_BLK_L
    JSR PUT_HEX2
    STA $07E5
    STX $07E6

    ; Status: PAUSE indicator or blank
    LDA PAUSE_FLAG
    BEQ STAT_BLANK
    LDA #$D0 ; 'P'
    STA $07E8
    LDA #$C1 ; 'A'
    STA $07E9
    LDA #$D5 ; 'U'
    STA $07EA
    LDA #$D3 ; 'S'
    STA $07EB
    LDA #$C5 ; 'E'
    STA $07EC
    RTS

STAT_BLANK:
    LDA #$A0
    STA $07E8
    STA $07E9
    STA $07EA
    STA $07EB
    STA $07EC
    RTS

PUT_DEC2:
    LDX #0
PD_LOOP:
    CMP #10
    BCC PD_DONE
    SBC #10
    INX
    BNE PD_LOOP
PD_DONE:
    PHA
    TXA
    ORA #$B0
    TAY
    PLA
    ORA #$B0
    TAX
    TYA
    RTS

PUT_HEX2:
    PHA
    LSR A
    LSR A
    LSR A
    LSR A
    JSR NIB_HEX
    TAY
    PLA
    AND #$0F
    JSR NIB_HEX
    TAX
    TYA
    RTS

NIB_HEX:
    CMP #10
    BCC NH_DIG
    CLC
    ADC #$C1 - 10
    RTS
NH_DIG:
    CLC
    ADC #$B0
    RTS

DISK_FAIL:
    JSR IRQ_OFF
    JSR SILENCE_ALL
    LDY #0
DF_LOOP:
    LDA ERRMSG,Y
    BEQ DF_DONE
    ORA #$80
    STA $06D0,Y
    INY
    BNE DF_LOOP
DF_DONE:
    RTS

ERRMSG:
    ASC "DISK ERR - STREAM BLOCK UNREADABLE"
    !byte 0

; --------------------------------------------------------------------------
; Parameters & State
; --------------------------------------------------------------------------
PARAMS:
    !byte 3
PARAM_UNIT:
    !byte 0
PARAM_BUF:
    !word BUF_LO
PARAM_BLK:
    !word 0

BLK_L:          !byte 0
BLK_H:          !byte 0
ERR:            !byte 0
ERRCODE:        !byte 0
DONE_FLAG:      !byte 0
PAUSE_FLAG:     !byte 0
MASTER_VOL:     !byte 15

PREFILL_L:      !byte 0
PREFILL_H:      !byte 0
PCM_CNT:        !byte 0

DIRTY_UI:       !byte 1
DISP_FRM:       !byte 0
DISP_SEC:       !byte 0
DISP_MIN:       !byte 0
DISP_BLK_L:     !byte 0
DISP_BLK_H:     !byte 0

CLK_FRM:        !byte 0
CLK_SEC:        !byte 0
CLK_MIN:        !byte 0

OLD_L:          !byte 0
OLD_H:          !byte 0
SAV_X:          !byte 0
SAV_Y:          !byte 0
PROD_V:         !byte 0
PROD_L:         !byte 0
PROD_H:         !byte 0

SHADOW:
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
