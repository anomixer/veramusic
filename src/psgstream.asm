; ==============================================================================
; VERA PSG Stream Player for Apple II (mod2psg .psg format, disk streaming)
; Companion to psgplay.asm (RAM version). The .psg stream lives in CONTIGUOUS
; raw blocks on disk starting at STREAM_BLK0 (written by build_jukebox.mjs,
; NOT a ProDOS file). A 512-byte buffer at $4000 is refilled via ProDOS MLI
; READ_BLOCK ($80) whenever the feeder crosses $41FF — same pattern as the
; slideshow ZSM engine (MLI from IRQ context is proven on real hardware;
; main loop performs no disk I/O, so the MLI is single-user).
;
; Stream FORMAT: identical to psgplay.asm (count/reg/val records, $FF +
; loopFrame u16 terminator). Loop = reset block counter + refill + skip.
; MLI clobbers A/X/Y/P (Time Pilot lesson) -> REFILL preserves all four.
;
; Controls: ESC/Q = exit, M = mute (64-byte shadow restore).
; Status: title row 0, "F:xxxxxx B:xxxx M_" row 23 ($07D0), "DISK ERR" row 22.
; Conventions: asm6502.mjs syntax, VERA_BASE injected, $2000 BRUN, dual slot.
; Zero page $06-$08, $19-$1B. Buffer $4000-$41FF. Code must stay below $3800.
; ==============================================================================

* = $2000

MLI         = $BF00
PRODOS_UNIT = $BF30

STREAM_L = $06       ; feeder pointer into $4000 buffer (zp, for (zp),Y)
STREAM_H = $07
CNT      = $08
SAV_L    = $19
SAV_M    = $1A
SAV_H    = $1B

BUF_LO  = $4000      ; 512-byte stream buffer (fixed)
BUF_HI  = $4200      ; = BUF_LO + $200 (exclusive end, full 512-byte ProDOS block)

STREAM_BLK0 = 100    ; first raw block of .psg stream (build_jukebox.mjs agrees)

START:
    SEI
    CLD                   ; ADC below assumes binary mode
    LDA #$00
    STA VERA_IEN
    LDA #$01
    STA VERA_ISR
    STA KBD_STROBE

    JSR SILENCE_ALL
    LDA PRODOS_UNIT
    STA PARAM_UNIT      ; bind all block reads to boot device (slideshow idiom)

    LDA #<STREAM_BLK0
    STA BLK_L
    LDA #>STREAM_BLK0
    STA BLK_H
    LDA #15
    STA MASTER_VOL
    LDA #$00
    STA FRM0
    STA FRM1
    STA FRM2
    STA MUTE
    STA ERR
    STA DONE_FLAG
    STA LOOP_L
    STA LOOP_H
    JSR REFILL_MAIN     ; first block synchronously (IRQ not hooked yet)
    LDA ERR
    BEQ START_IRQ
    JSR SHOW_TITLE
    JMP DISK_FAIL       ; first block unreadable: report and exit

START_IRQ:
    JSR SHOW_TITLE
    JSR IRQ_ON

MAIN:
    LDA DONE_FLAG
    BNE DO_EXIT_JMP
    JSR SHOW_STATUS
    LDA ERR
    BEQ MAIN_NO_ERR
    JMP DISK_FAIL
MAIN_NO_ERR:
    LDA KBD_DATA
    BPL MAIN
    STA KBD_STROBE
    AND #$7F
    CMP #$1B
    BEQ DO_EXIT_JMP
    CMP #$51
    BEQ DO_EXIT_JMP
    CMP #$71
    BEQ DO_EXIT_JMP
    CMP #$50
    BEQ DO_MUTE_JMP
    CMP #$70
    BEQ DO_MUTE_JMP
    CMP #$4D
    BEQ DO_MUTE_JMP
    CMP #$6D
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

DO_VOL_UP:
    LDA MASTER_VOL
    CMP #15
    BCS VOL_DONE
    INC MASTER_VOL
    JSR APPLY_PSG_VOL
    JMP MAIN

DO_VOL_DOWN:
    LDA MASTER_VOL
    BEQ VOL_DONE
    DEC MASTER_VOL
    JSR APPLY_PSG_VOL
    JMP MAIN

VOL_DONE:
    JMP MAIN

DO_EXIT_JMP:
    JMP DO_EXIT
DO_MUTE_JMP:
    JMP DO_MUTE
DO_FF_JMP:
    JMP DO_SEEK_FWD
DO_RW_JMP:
    JMP DO_SEEK_BWD

; --------------------------------------------------------------------------
; Fast forward (]) & Backward ([) 5 seconds (300 frames @ 60 Hz)
; --------------------------------------------------------------------------
DO_SEEK_FWD:
    SEI
    LDA #<300
    STA SEEK_CNT_L
    LDA #>300
    STA SEEK_CNT_H
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
    JSR GETB              ; reg
    TAX
    JSR GETB              ; val
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
    LDA SEEK_CNT_L
    BNE SF_D1_S
    DEC SEEK_CNT_H
SF_D1_S:
    DEC SEEK_CNT_L
    LDA SEEK_CNT_L
    ORA SEEK_CNT_H
    BNE SF_LOOP_S

    CLC
    LDA CLK_SEC
    ADC #5
    CMP #60
    BCC SF_SEC_OK_S
    SBC #60
    INC CLK_MIN
SF_SEC_OK_S:
    STA CLK_SEC
    JSR RESTORE_ALL
    CLI
    JMP MAIN

SF_TERM_S:
    LDA #$01
    STA DONE_FLAG
    CLI
    JMP MAIN

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
    LDA #<STREAM_BLK0
    STA BLK_L
    LDA #>STREAM_BLK0
    STA BLK_H
    JSR REFILL
    LDA ERR
    BEQ SB_NOERR_S
    CLI
    JMP DISK_FAIL
SB_NOERR_S:
    LDA #0
    STA FRM0
    STA FRM1
    STA FRM2

    ; Clear SHADOW registers so we scan cleanly from start
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
    JSR GETB              ; reg
    TAX
    JSR GETB              ; val
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
    STA CLK_MIN
    LDA #0
SB_SEC_OK_S:
    STA CLK_SEC
    JSR RESTORE_ALL
    CLI
    JMP MAIN

DISK_FAIL:
    JSR IRQ_OFF_SAFE    ; IRQ may never have been hooked: restore only if ours
    JSR SILENCE_ALL
    LDY #$00
ERRMSG_LOOP:
    LDA ERRMSG,Y
    BEQ ERRMSG_DONE
    ORA #$80
    STA $06D0,Y         ; text row 22 base
    INY
    BNE ERRMSG_LOOP
ERRMSG_DONE:
    ; append " $XX" (raw MLI code) at $06F0-$06F3 so the failure is diagnosable
    LDA #$A0
    STA $06F0
    LDA #$A4              ; $
    STA $06F1
    LDX #$00              ; NIB_ERR index for $06F2+X
    LDA ERRCODE
    PHA
    LSR A
    LSR A
    LSR A
    LSR A
    JSR NIB_ERR
    PLA
    AND #$0F
    JSR NIB_ERR
    RTS
NIB_ERR:
    CMP #$0A
    BCC NIBD_ERR
    ADC #$36              ; C=1 from CMP. NO CLC here.
    ORA #$80
    STA $06F2,X
    INX
    RTS
NIBD_ERR:
    ORA #$B0
    STA $06F2,X
    INX
    RTS

DO_EXIT:
    JSR IRQ_OFF
    JSR SILENCE_ALL
    RTS

DO_MUTE:
    SEI
    LDA MUTE
    BNE UNMUTE
    LDA #$01
    STA MUTE
    JSR SILENCE_ALL
    CLI
    JMP MAIN
UNMUTE:
    JSR RESTORE_ALL
    LDA #$00
    STA MUTE
    CLI
    JMP MAIN

; --------------------------------------------------------------------------
; IRQ plumbing (same as psgplay.asm)
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

; Safe when IRQ was never hooked (disk failed before START_IRQ): only
; silence hardware + IEN off, do not touch the $03FE vector.
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
; TICK: one frame record per VSYNC, bytes via feeder GETB
; --------------------------------------------------------------------------
TICK:
    LDA MUTE
    BNE TICK_DONE
    JSR GETB              ; count byte
    CMP #$FF
    BEQ DO_FINISH
    CMP #$41
    BCC TICK_CNT_OK2
    JMP DO_RESTART        ; too far for BCS (assembler enforces range)
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
    STA VERA_ADDR_L
    LDA #$F9
    ADC #$00
    STA VERA_ADDR_M
    LDA #$11
    STA VERA_ADDR_H
    PLA
    STA VERA_DATA0
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

DO_LOOP:
    JSR GETB              ; loopFrame lo
    STA LOOP_L
    JSR GETB              ; loopFrame hi
    STA LOOP_H
    LDA #<STREAM_BLK0
    STA BLK_L
    LDA #>STREAM_BLK0
    STA BLK_H
    JSR REFILL            ; IRQ context refill (preserves regs)
    LDA ERR
    BNE TICK_DONE         ; main loop will report + exit
    LDA LOOP_L
    ORA LOOP_H
    BEQ LOOP_RESET_ONLY
SKIP:
    LDA LOOP_L
    ORA LOOP_H
    BEQ LOOP_RESET_ONLY
    JSR GETB
    CMP #$FF
    BEQ DO_RESTART
    TAX
    TXA
    BEQ SKIP_NEXT
SKIPB:
    JSR GETB
    JSR GETB
    DEX
    BNE SKIPB
SKIP_NEXT:
    LDA LOOP_L
    BNE SKIP_DECLO
    DEC LOOP_H
SKIP_DECLO:
    DEC LOOP_L
    JMP SKIP
LOOP_RESET_ONLY:
    LDA #$00
    STA FRM0
    STA FRM1
    STA FRM2
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN
    RTS

DO_RESTART:
    LDA #<STREAM_BLK0
    STA BLK_L
    LDA #>STREAM_BLK0
    STA BLK_H
    JSR REFILL
    LDA #$00
    STA FRM0
    STA FRM1
    STA FRM2
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN
    RTS

; --------------------------------------------------------------------------
; Feeder: A = next stream byte. Refills 512 B block at $41FF boundary.
; Clobbers A only (X/Y preserved across REFILL; see below).
; --------------------------------------------------------------------------
GETB:
    LDA STREAM_H
    CMP #>BUF_HI          ; >= $42 ?
    BCC GETB_READY
    JSR REFILL
GETB_READY:
    LDY #$00
    LDA (STREAM_L),Y
    PHA                   ; save byte across ADV_PTR (X/Y untouched anyway)
    INC STREAM_L
    BNE GETB_OK
    INC STREAM_H
GETB_OK:
    PLA
    RTS

; REFILL: read BLK_L/H -> $4000, BLK++, PTR=$4000. Sets ERR=1 on MLI error.
; Preserves A/X/Y/P (MLI clobbers them; TICK holds reg in X across GETB).
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
    STA ERRCODE       ; raw MLI error ($28=no device, $27=I/O, $2B=wprot...)
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

; First-block load from main context (same path, flags ERR identically)
REFILL_MAIN:
    LDA #<STREAM_BLK0
    STA BLK_L
    LDA #>STREAM_BLK0
    STA BLK_H
    JSR REFILL
    RTS

; --------------------------------------------------------------------------
; PSG helpers (same as psgplay.asm)
; --------------------------------------------------------------------------
SILENCE_ALL:
    LDA #$00
    STA VERA_CTRL
    LDA #$C0
    STA VERA_ADDR_L
    LDA #$F9
    STA VERA_ADDR_M
    LDA #$11
    STA VERA_ADDR_H
    LDX #$40
    LDA #$00
SILENCE_LOOP:
    STA VERA_DATA0
    DEX
    BNE SILENCE_LOOP
    RTS

RESTORE_ALL:
    LDA #$00
    STA VERA_CTRL
    LDX #$00
RESTORE_LOOP:
    LDA SHADOW,X
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
    LDA #$11
    STA VERA_ADDR_H
    PLA
    STA VERA_DATA0
    INX
    CPX #$40
    BCC RESTORE_LOOP
    RTS

APPLY_PSG_VOL:
    SEI
    LDA MUTE
    BNE APV_PSG_MUTED
    JSR RESTORE_ALL
APV_PSG_MUTED:
    CLI
    RTS

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

; --------------------------------------------------------------------------
; Text status. Row 0 title, row 23 "F:xxxxxx B:xxxx M_".
; --------------------------------------------------------------------------
SHOW_TITLE:
    LDY #$00
TITLE_LOOP:
    LDA TITLE,Y
    BEQ TITLE_ROW2
    ORA #$80
    STA $0400,Y
    INY
    BNE TITLE_LOOP
TITLE_ROW2:
    LDY #$00
TITLE2_LOOP:
    LDA TITLE2,Y
    BEQ TITLE_DONE
    ORA #$80
    STA $0480,Y
    INY
    BNE TITLE2_LOOP
TITLE_DONE:
    RTS

SHOW_STATUS:
    SEI
    LDA CLK_FRM
    STA DISP_FRM
    LDA CLK_SEC
    STA DISP_SEC
    LDA CLK_MIN
    STA DISP_MIN
    LDA BLK_H
    STA DISPB_H
    LDA BLK_L
    STA DISPB_L
    CLI

    ; Write "T: mm:ss.s B:xxxx" at $07D0
    LDA #$D4              ; 'T'
    STA $07D0
    LDA #$BA              ; ':'
    STA $07D1
    LDA #$A0              ; ' '
    STA $07D2

    ; Format minutes (0..99) -> $07D3, $07D4
    LDA DISP_MIN
    LDX #$00
DIV10_MIN:
    CMP #10
    BCC DIV10_MIN_DONE
    SEC
    SBC #10
    INX
    BNE DIV10_MIN
DIV10_MIN_DONE:
    PHA
    TXA
    ORA #$B0
    STA $07D3
    PLA
    ORA #$B0
    STA $07D4

    LDA #$BA              ; ':'
    STA $07D5

    ; Format seconds (0..59) -> $07D6, $07D7
    LDA DISP_SEC
    LDX #$00
DIV10_SEC:
    CMP #10
    BCC DIV10_SEC_DONE
    SEC
    SBC #10
    INX
    BNE DIV10_SEC
DIV10_SEC_DONE:
    PHA
    TXA
    ORA #$B0
    STA $07D6
    PLA
    ORA #$B0
    STA $07D7

    LDA #$AE              ; '.'
    STA $07D8

    ; Format tenths (DISP_FRM / 6) -> $07D9
    LDA DISP_FRM
    LDX #$00
DIV6_FRM:
    CMP #6
    BCC DIV6_FRM_DONE
    SEC
    SBC #6
    INX
    BNE DIV6_FRM
DIV6_FRM_DONE:
    TXA
    ORA #$B0
    STA $07D9

    LDA #$A0              ; ' '
    STA $07DA
    LDA #$C2              ; 'B'
    STA $07DB
    LDA #$BA              ; ':'
    STA $07DC

    LDX #$00              ; block counter: DISPB_H at $07DD-$07DE, DISPB_L at $07DF-$07E0
    LDA DISPB_H
    JSR HEXBYTE_AT_DD
    LDA DISPB_L
    JSR HEXBYTE_AT_DD

    ; Volume: " V:xx" at $07E1..$07E5
    LDA #$A0              ; ' '
    STA $07E1
    LDA #$D6              ; 'V'
    STA $07E2
    LDA #$BA              ; ':'
    STA $07E3

    LDA MASTER_VOL
    LDX #$B0              ; '0'
DIV10_VOL:
    CMP #10
    BCC DIV10_VOL_DONE
    SEC
    SBC #10
    INX
    BNE DIV10_VOL
DIV10_VOL_DONE:
    PHA
    TXA
    STA $07E4             ; tens ('0' or '1')
    PLA
    ORA #$B0
    STA $07E5             ; units ('0'..'9')

    ; Pause indicator: " P" at $07E6..$07E7
    LDA #$A0
    STA $07E6
    STA $07E7
    LDA MUTE
    BEQ STATUS_UNMUTED
    LDA #$D0              ; 'P'
    STA $07E7
STATUS_UNMUTED:
    RTS

; A = byte -> 2 hex chars at $07DD+X (block) ; X += 2 (X enters 0)
HEXBYTE_AT_DD:
    PHA
    LSR A
    LSR A
    LSR A
    LSR A
    JSR NIB_DD
    PLA
    AND #$0F
    JSR NIB_DD
    RTS
NIB_DD:
    CMP #$0A
    BCC NIBD_DD
    ADC #$36              ; C=1 from CMP. NO CLC here.
    ORA #$80
    STA $07DD,X
    INX
    RTS
NIBD_DD:
    ORA #$B0
    STA $07DD,X
    INX
    RTS

TITLE:
    ASC "VERA PSG STREAM 60HZ R5                 "
    !byte 0
TITLE2:
    ASC "ESC=EXIT P=PAUSE +,-=VOL [,]=SEEK       "
    !byte 0
ERRMSG:
    ASC "DISK ERR - STREAM BLOCK UNREADABLE"
    !byte 0

; --------------------------------------------------------------------------
; State + MLI params
; --------------------------------------------------------------------------
SHADOW:
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
    HEX 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
FRM0:
    !byte 0
FRM1:
    !byte 0
FRM2:
    !byte 0
CLK_FRM:
    !byte 0
CLK_SEC:
    !byte 0
CLK_MIN:
    !byte 0
DISP_FRM:
    !byte 0
DISP_SEC:
    !byte 0
DISP_MIN:
    !byte 0
DISP0:
    !byte 0
DISP1:
    !byte 0
DISP2:
    !byte 0
DISPB_L:
    !byte 0
DISPB_H:
    !byte 0
LOOP_L:
    !byte 0
LOOP_H:
    !byte 0
BLK_L:
    !byte 0
BLK_H:
    !byte 0
MUTE:
    !byte 0
ERR:
    !byte 0
ERRCODE:
    !byte 0
DONE_FLAG:
    !byte 0
OLD_L:
    !byte 0
OLD_H:
    !byte 0
MASTER_VOL:
    !byte 15
PROD_V:
    !byte 0
PROD_L:
    !byte 0
PROD_H:
    !byte 0
SAV_X:
    !byte 0
SAV_Y:
    !byte 0
SEEK_CNT_L:
    !byte 0
SEEK_CNT_H:
    !byte 0
TARG_L:
    !byte 0
TARG_H:
    !byte 0
PARAMS:
    !byte $03
PARAM_UNIT:
    !byte $00
    !word $4000
PARAM_BLK:
    !word $0000
