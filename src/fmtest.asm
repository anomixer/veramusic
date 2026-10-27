; ==============================================================================
; ZSMPLAY.ASM — Apple II VERA FM/PSG ZSM Player
; Loaded via BRUN at $2000 under ProDOS BASIC.SYSTEM.
; Writes a short built-in sequence to the YM2151 (FM) registers.
; Exit: RTS back to BASIC (BRUN vectors return to BASIC.SYSTEM).
; ==============================================================================
* = $2000

; YM_SEL / YM_DATA come from vera.inc, with FM_BASE selected by slot.
KBD_STROBE = $C000

START:
    SEI
    CLD
    LDA #$00
    STA KBD_STROBE

    JSR INIT_FM
    JSR PLAY_TEST
    JSR KEY_OFF_ALL

    CLI
    RTS                          ; return to BASIC.SYSTEM (BRUN entry vector)

; ---------------------------------------------------------------------------
; INIT_FM — program YM2151 channel 0: algorithm 7, max volume, fast attack
; ---------------------------------------------------------------------------
INIT_FM:
    LDX #0
INIT_LOOP:
    LDA INIT_REGS,X
    CMP #$FF
    BEQ INIT_DONE
    STA YM_SEL
    LDA INIT_REGS+1,X
    STA YM_DATA
    INX
    INX
    JMP INIT_LOOP
INIT_DONE:
    RTS

; ---------------------------------------------------------------------------
; PLAY_TEST — walk the built-in test event list, writing FM reg/val pairs
; ---------------------------------------------------------------------------
PLAY_TEST:
    LDX #0
TEST_LOOP:
    LDA TEST_EVENTS,X
    CMP #$FF                    ; $FF = end of stream
    BEQ TEST_DONE
    STA YM_SEL
    LDA TEST_EVENTS+1,X
    STA YM_DATA
    INX
    INX
    JSR DELAY_FRAME
    JMP TEST_LOOP
TEST_DONE:
    RTS

KEY_OFF_ALL:
    LDA #$08
    STA YM_SEL
    LDA #$00
    STA YM_DATA
    RTS

; ---------------------------------------------------------------------------
; DELAY_FRAME — ~1 frame (approximate, tuned for 1 MHz 6502)
; ---------------------------------------------------------------------------
DELAY_FRAME:
    TXA              ; preserve stream index X
    PHA
    LDX #$30
D1: LDY #$FF
DI: DEY
    BNE DI
    DEX
    BNE D1
    PLA
    TAX              ; restore stream index X
    RTS

; ---------------------------------------------------------------------------
; INIT_REGS — reg/val pairs for ch0 operator setup (terminated by $FF reg)
; ---------------------------------------------------------------------------
INIT_REGS:
    .byte $20, $C7              ; RL=L+R, CON=7 (parallel operators)
    .byte $40, $01              ; op0 MUL=1
    .byte $48, $01              ; op1 MUL=1
    .byte $50, $01              ; op2 MUL=1
    .byte $58, $01              ; op3 MUL=1
    .byte $60, $00              ; op0 TL=0 (max volume)
    .byte $68, $00              ; op1 TL=0
    .byte $70, $00              ; op2 TL=0
    .byte $78, $00              ; op3 TL=0
    .byte $80, $1F              ; AR=max (instant attack)
    .byte $88, $1F
    .byte $90, $1F
    .byte $98, $1F
    .byte $E0, $07              ; RR fast
    .byte $E8, $07
    .byte $F0, $07
    .byte $F8, $07
    .byte $FF                    ; terminator

; ---------------------------------------------------------------------------
; TEST_EVENTS — FM test reg/val pairs (terminated by $FF)
; ---------------------------------------------------------------------------
TEST_EVENTS:
    .byte $28, $4A              ; KC concert A
    .byte $08, $78              ; key on ch0
    .byte $08, $00              ; key off
    .byte $28, $5A              ; KC octave 5
    .byte $08, $78              ; key on
    .byte $08, $00              ; key off
    .byte $FF                    ; terminator
