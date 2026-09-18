; ==============================================================================
; VERA PSG Stream Player for Apple II (mod2psg .psg format)
; VSYNC-IRQ-driven 60 Hz register-write player. RAM-resident stream version:
; the .psg event stream is appended right after this binary by build script.
; Large streams (e.g. 47 KB BreakLine) do NOT fit main RAM -> HDV streaming
; variant belongs to the Jukebox step. This player targets small tunes.
;
; Stream FORMAT (mod2psg v0.3): per VSYNC frame [count u8][(reg u8,val u8)*]
;   reg 0..63 = channel*4+field (player adds PSG base $1F9C0)
;   count 0 = hold frame (no writes). Terminator: [$FF][loopFrame u16 LE].
;   loopFrame = frame index to resume at (0 = restart). Player rewinds to
;   stream start and skips loopFrame records (one VSYNC hiccup per loop).
;
; Controls: ESC/Q = exit to BASIC, M = mute toggle (shadow restore).
; Status: title on text row 0, hex frame counter + mute flag on row 23.
; Conventions: veratest asm6502.mjs syntax, VERA_BASE injected, $2000 BRUN,
; dual-slot build (*.BIN + *4.BIN). Zero page $06-$08, $19-$1B (slideshow-style).
; ==============================================================================

* = $2000

STREAM_L = $06       ; stream pointer (zp, for (zp),Y reads)
STREAM_H = $07
CNT      = $08       ; per-frame pair counter (zp ok, abs-encoded, fine)
SAV_L    = $19       ; IRQ VERA address save (mirror slideshow $19-$1B)
SAV_M    = $1A
SAV_H    = $1B

START:
    ; 1. IRQ safety, no video touch (Apple II text screen stays visible)
    SEI
    CLD                   ; ADC below assumes binary mode (ProDOS leaves D=0, don't rely on it)
    LDA #$00
    STA VERA_IEN          ; disable VERA interrupts
    LDA #$01
    STA VERA_ISR          ; clear pending VSYNC
    STA KBD_STROBE        ; clear keyboard strobe

    ; 2. Silence all 16 PSG channels, init state
    JSR SILENCE_ALL
    LDA #<STREAM_DATA
    STA STREAM_L
    LDA #>STREAM_DATA
    STA STREAM_H
    LDA #15
    STA MASTER_VOL
    LDA #$00
    STA FRM0
    STA FRM1
    STA FRM2
    STA MUTE
    STA LOOP_L
    STA LOOP_H

    ; 3. Title card on text page
    JSR SHOW_TITLE

    ; 4. Hook VSYNC IRQ and go
    JSR IRQ_ON

MAIN:
    JSR SHOW_STATUS
    LDA KBD_DATA
    BPL MAIN              ; no key yet
    STA KBD_STROBE
    AND #$7F
    CMP #$1B              ; ESC
    BEQ DO_EXIT_JMP
    CMP #$51              ; Q
    BEQ DO_EXIT_JMP
    CMP #$71              ; q
    BEQ DO_EXIT_JMP
    CMP #$50              ; P
    BEQ DO_MUTE_JMP
    CMP #$70              ; p
    BEQ DO_MUTE_JMP
    CMP #$4D              ; M
    BEQ DO_MUTE_JMP
    CMP #$6D              ; m
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
SF_LOOP_P:
    LDY #$00
    LDA (STREAM_L),Y      ; count byte
    CMP #$FF
    BEQ SF_END_P
    CMP #$41
    BCS SF_END_P
    STA CNT
    JSR ADV_PTR
    LDA CNT
    BEQ SF_HOLD_P
SF_PAIR_P:
    LDY #$00
    LDA (STREAM_L),Y      ; reg 0..63
    TAX
    JSR ADV_PTR
    LDA (STREAM_L),Y      ; val
    STA SHADOW,X
    JSR ADV_PTR
    DEC CNT
    BNE SF_PAIR_P
SF_HOLD_P:
    INC FRM0
    BNE SF_F1_P
    INC FRM1
    BNE SF_F1_P
    INC FRM2
SF_F1_P:
    LDA SEEK_CNT_L
    BNE SF_D1_P
    DEC SEEK_CNT_H
SF_D1_P:
    DEC SEEK_CNT_L
    LDA SEEK_CNT_L
    ORA SEEK_CNT_H
    BNE SF_LOOP_P

    CLC
    LDA CLK_SEC
    ADC #5
    CMP #60
    BCC SF_SEC_OK_P
    SBC #60
    INC CLK_MIN
SF_SEC_OK_P:
    STA CLK_SEC
    JSR RESTORE_ALL
    CLI
    JMP MAIN

SF_END_P:
    JSR DO_RESTART
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
    BCS SB_TARG_OK_P

    LDA #0
    STA TARG_L
    STA TARG_H
SB_TARG_OK_P:
    LDA #<STREAM_DATA
    STA STREAM_L
    LDA #>STREAM_DATA
    STA STREAM_H
    LDA #0
    STA FRM0
    STA FRM1
    STA FRM2

    ; Clear SHADOW registers so we scan cleanly from frame 0
    LDX #$00
    TXA
SB_CLR_SHADOW_P:
    STA SHADOW,X
    INX
    CPX #$40
    BNE SB_CLR_SHADOW_P

    LDA TARG_L
    ORA TARG_H
    BNE SB_SCAN_P
    ; Rewind to frame 0: silence hardware and reset clock
    JSR SILENCE_ALL
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN
    CLI
    JMP MAIN

SB_SCAN_P:
SB_SCAN_LOOP_P:
    LDY #$00
    LDA (STREAM_L),Y
    CMP #$FF
    BEQ SB_DONE_P
    CMP #$41
    BCS SB_DONE_P
    STA CNT
    JSR ADV_PTR
    LDA CNT
    BEQ SBS_HOLD_P
SBS_PAIR_P:
    LDY #$00
    LDA (STREAM_L),Y
    TAX
    JSR ADV_PTR
    LDA (STREAM_L),Y
    STA SHADOW,X
    JSR ADV_PTR
    DEC CNT
    BNE SBS_PAIR_P
SBS_HOLD_P:
    INC FRM0
    BNE SBS_F1_P
    INC FRM1
    BNE SBS_F1_P
    INC FRM2
SBS_F1_P:
    LDA TARG_L
    BNE SBS_D1_P
    DEC TARG_H
SBS_D1_P:
    DEC TARG_L
    LDA TARG_L
    ORA TARG_H
    BNE SB_SCAN_LOOP_P

SB_DONE_P:
    LDA CLK_SEC
    SEC
    SBC #5
    BCS SB_SEC_OK_P
    LDA CLK_MIN
    BEQ SB_MIN_ZERO_P
    DEC CLK_MIN
    LDA CLK_SEC
    CLC
    ADC #55
    JMP SB_SEC_OK_P
SB_MIN_ZERO_P:
    LDA #0
    STA CLK_MIN
    LDA #0
SB_SEC_OK_P:
    STA CLK_SEC
    JSR RESTORE_ALL
    CLI
    JMP MAIN

DO_EXIT:
    JSR IRQ_OFF
    JSR SILENCE_ALL       ; leave hardware quiet (shadow keeps song state)
    RTS                   ; back to Applesoft BASIC

DO_MUTE:
    SEI                   ; atomic vs IRQ tick
    LDA MUTE
    BNE UNMUTE
    LDA #$01
    STA MUTE
    JSR SILENCE_ALL       ; hardware quiet, SHADOW untouched
    CLI
    JMP MAIN
UNMUTE:
    JSR RESTORE_ALL       ; replay 64 shadow regs, glitch-free resume
    LDA #$00
    STA MUTE
    CLI
    JMP MAIN

; --------------------------------------------------------------------------
; IRQ plumbing (slideshow pattern: $03FE hook, VSYNC ack, VERA addr save)
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
    STA VERA_ISR          ; clear pending VSYNC
    STA VERA_IEN          ; enable VSYNC interrupt
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
    STA VERA_ISR          ; acknowledge VSYNC
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
; TICK: advance exactly one frame record per VSYNC
; --------------------------------------------------------------------------
TICK:
    LDA MUTE
    BEQ TICK_NOT_MUTED
    RTS
TICK_NOT_MUTED:
    LDY #$00
    LDA (STREAM_L),Y      ; count byte
    CMP #$FF
    BEQ DO_LOOP
    CMP #$41              ; sanity: count must be < 65
    BCC TICK_CNT_OK
    JMP DO_RESTART        ; corrupt -> restart song (too far for BCS)
TICK_CNT_OK:
    STA CNT
    JSR ADV_PTR           ; past count byte — ALWAYS (a count-0 frame that
    LDX CNT               ;   doesn't advance re-reads the same 0 forever)
    BEQ TICK_BUMP         ; count 0 = hold frame
PAIR:
    LDA (STREAM_L),Y      ; reg 0..63
    TAX
    JSR ADV_PTR
    LDA (STREAM_L),Y      ; val
    JSR ADV_PTR
    STA SHADOW,X          ; remember unscaled for volume adjustments & mute-restore
    TXA
    AND #$03
    CMP #$02              ; is this a volume register? (reg & 3 == 2)
    BNE PAIR_NOSCALE
    LDA SHADOW,X
    JSR SCALE_PSG_REG
    JMP PAIR_WRITE
PAIR_NOSCALE:
    LDA SHADOW,X
PAIR_WRITE:
    PHA
    TXA
    CLC
    ADC #$C0              ; VRAM $1F9C0 + reg (low)
    STA VERA_ADDR_L
    LDA #$F9
    ADC #$00              ; carry from low (high)
    STA VERA_ADDR_M
    LDA #$11              ; bank 1, stride +1
    STA VERA_ADDR_H
    PLA
    STA VERA_DATA0
    DEC CNT
    BNE PAIR
TICK_BUMP:
    INC FRM0              ; 24-bit frame counter for status line
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

; Terminator $FF: [loopFrame u16 LE] -> rewind + skip, reset frame counter
DO_LOOP:
    JSR ADV_PTR           ; past $FF
    LDY #$00
    LDA (STREAM_L),Y
    STA LOOP_L
    JSR ADV_PTR
    LDA (STREAM_L),Y
    STA LOOP_H
    ; rewind to stream start
    LDA #<STREAM_DATA
    STA STREAM_L
    LDA #>STREAM_DATA
    STA STREAM_H
    LDA LOOP_L
    ORA LOOP_H
    BEQ LOOP_RESET_ONLY
SKIP:
    LDA LOOP_L
    ORA LOOP_H
    BEQ LOOP_RESET_ONLY
    LDY #$00
    LDA (STREAM_L),Y      ; count of frame to skip
    CMP #$FF
    BEQ DO_RESTART        ; malformed guard: restart instead of hanging
    TAX
    JSR ADV_PTR
    TXA
    BEQ SKIP_NEXT         ; count 0: nothing to skip
SKIPB:
    JSR ADV_PTR
    JSR ADV_PTR
    DEX
    BNE SKIPB
SKIP_NEXT:
    LDA LOOP_L            ; 16-bit DEC loop counter
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

; Corrupt/guard entry: restart song from stream start
DO_RESTART:
    JSR SILENCE_ALL
    LDX #$00
    TXA
DR_CLR_SHADOW:
    STA SHADOW,X
    INX
    CPX #$40
    BNE DR_CLR_SHADOW
    LDA #<STREAM_DATA
    STA STREAM_L
    LDA #>STREAM_DATA
    STA STREAM_H
    LDA #$00
    STA FRM0
    STA FRM1
    STA FRM2
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN
    RTS

; ptr++ (16-bit)
ADV_PTR:
    INC STREAM_L
    BNE ADV_PTR_OK
    INC STREAM_H
ADV_PTR_OK:
    RTS

; --------------------------------------------------------------------------
; PSG helpers
; --------------------------------------------------------------------------
SILENCE_ALL:
    LDA #$00
    STA VERA_CTRL
    LDA #$C0
    STA VERA_ADDR_L
    LDA #$F9
    STA VERA_ADDR_M
    LDA #$11              ; stride +1, bank 1 ($1F9C0)
    STA VERA_ADDR_H
    LDX #$40
    LDA #$00
SILENCE_LOOP:
    STA VERA_DATA0
    DEX
    BNE SILENCE_LOOP
    RTS

; Replay all 64 shadow regs (unmute resume + init safety)
RESTORE_ALL:
    LDA #$00
    STA VERA_CTRL
    LDX #$00
RESTORE_LOOP:
    LDA SHADOW,X
    PHA
    TXA
    AND #$03
    CMP #$02
    BNE RESTORE_NOSCALE
    PLA
    JSR SCALE_PSG_REG
    PHA
RESTORE_NOSCALE:
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
; Text status (Apple II text page, high bit set). Row 0 title, row 23 status.
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

; Row 23 ($07D0): "T: mm:ss.s" + space + mute flag
SHOW_STATUS:
    SEI                   ; tear-free sample
    LDA CLK_FRM
    STA DISP_FRM
    LDA CLK_SEC
    STA DISP_SEC
    LDA CLK_MIN
    STA DISP_MIN
    CLI

    LDA #$D4              ; 'T'
    STA $07D0
    LDA #$BA              ; ':'
    STA $07D1
    LDA #$A0              ; ' '
    STA $07D2

    ; Format minutes (0..99) -> $07D3, $07D4
    LDA DISP_MIN
    JSR DIV10_P
    STX $07D3
    ORA #$B0
    STA $07D4

    LDA #$BA              ; ':'
    STA $07D5

    ; Format seconds (0..59) -> $07D6, $07D7
    LDA DISP_SEC
    JSR DIV10_P
    STX $07D6
    ORA #$B0
    STA $07D7

    LDA #$AE              ; '.'
    STA $07D8

    ; Format tenths (DISP_FRM / 6) -> $07D9
    LDA DISP_FRM
    LDX #$00
DIV6_FRM_P:
    CMP #6
    BCC DIV6_FRM_DONE_P
    SEC
    SBC #6
    INX
    BNE DIV6_FRM_P
DIV6_FRM_DONE_P:
    TXA
    ORA #$B0
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
METER_LOOP_P:
    LDA SHADOW,Y
    AND #$3F              ; extract volume bits 5:0
    BEQ METER_DOT_P
    CMP #15
    BCC METER_DASH_P
    CMP #35
    BCC METER_EQ_P
    CMP #50
    BCC METER_HASH_P
    LDA #$DE              ; '^'
    !byte $2C             ; BIT abs (skip next 2 bytes)
METER_HASH_P:
    LDA #$A3              ; '#'
    !byte $2C
METER_EQ_P:
    LDA #$BD              ; '='
    !byte $2C
METER_DASH_P:
    LDA #$AD              ; '-'
    !byte $2C
METER_DOT_P:
    LDA #$AE              ; '.'
METER_PUT_P:
    STA $07DC,X
    INX
    TYA
    CLC
    ADC #$04              ; next voice ctrl offset
    TAY
    CPX #$10              ; 16 voices done?
    BNE METER_LOOP_P
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
    JSR DIV10_P
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

DIV10_P:
    LDX #$B0
DIV10_PL:
    CMP #10
    BCC DIV10_PD
    SEC
    SBC #10
    INX
    BNE DIV10_PL
DIV10_PD:
    RTS

TITLE:
    ASC "VERA PSG PLAYER 60HZ R6          "
    !byte 0
TITLE2:
    ASC "ESC=EXIT P=PAUSE +,-=VOL [,]=SEEK"
    !byte 0

; --------------------------------------------------------------------------
; State (absolute RAM inside binary) + stream base for build script append
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
LOOP_L:
    !byte 0
LOOP_H:
    !byte 0
MUTE:
    !byte 0
MASTER_VOL:
    !byte 15
PROD_L:
    !byte 0
PROD_H:
    !byte 0
PROD_V:
    !byte 0
SAV_X:
    !byte 0
SAV_Y:
    !byte 0
OLD_L:
    !byte 0
OLD_H:
    !byte 0
SEEK_CNT_L:
    !byte 0
SEEK_CNT_H:
    !byte 0
TARG_L:
    !byte 0
TARG_H:
    !byte 0

; *** build script appends the .psg stream bytes right here ***
STREAM_DATA:
