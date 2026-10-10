; ==============================================================================
; ZSMPLAY.ASM — Apple II VERA FM/PSG ZSM Player
; Loaded via BRUN at $2000 under ProDOS BASIC.SYSTEM.
; Plays embedded ZSM event stream to YM2151 (FM) registers.
; Exit: RTS back to BASIC (BRUN vectors return to BASIC.SYSTEM).
; ==============================================================================
* = $2000

VERA_BASE = $C200
YM_REG    = VERA_BASE + $20      ; YM2151 register select
YM_DATA   = VERA_BASE + $21      ; YM2151 data / status
KBD_STROBE = $C000

START:
    SEI
    CLD
    LDA #$00
    STA KBD_STROBE

    JSR INIT_FM
    JSR PLAY_STREAM
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
    STA YM_REG
    LDA INIT_REGS+1,X
    STA YM_DATA
    INX
    INX
    JMP INIT_LOOP
INIT_DONE:
    RTS

; ---------------------------------------------------------------------------
; PLAY_STREAM — walk the embedded ZSM event list, writing FM reg/val pairs
; ---------------------------------------------------------------------------
PLAY_STREAM:
    LDX #0
STREAM_LOOP:
    LDA ZSM_STREAM,X
    CMP #$FF                    ; $FF = end of stream
    BEQ STREAM_DONE
    STA YM_REG
    LDA ZSM_STREAM+1,X
    STA YM_DATA
    INX
    INX
    JSR DELAY_FRAME
    JMP STREAM_LOOP
STREAM_DONE:
    RTS

KEY_OFF_ALL:
    LDA #$08
    STA YM_REG
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
    .byte $60, $7F              ; op0 TL=0 (max volume)
    .byte $68, $7F              ; op1 TL=0
    .byte $70, $7F              ; op2 TL=0
    .byte $78, $7F              ; op3 TL=0
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
; ZSM_STREAM — FM reg/val pairs from TITLE.ZSM intro (terminated by $FF)
; ---------------------------------------------------------------------------
ZSM_STREAM:
    .byte $28, $4A              ; KC concert A
    .byte $08, $78              ; key on ch0
    .byte $08, $00              ; key off
    .byte $28, $5A              ; KC octave 5
    .byte $08, $78              ; key on
    .byte $08, $00              ; key off
    .byte $FF                    ; terminator
