; ==============================================================================
; VERA PCM RAM Player for Apple II (8-bit signed mono PCM)
;
; Plays 8-bit signed PCM audio from Apple II RAM using the VERA PCM engine.
; The PCM sample data is appended directly after this binary.
;
; Header at $2003:
;   +0: JMP START ($2000-$2002)
;   +3: PCM_LEN  (word)  - length of PCM data in bytes
;   +5: RATE_VAL (byte)  - VERA_AUDIO_RATE register (e.g. 21 for 8010 Hz)
;   +6: LOOP_ENA (byte)  - 1 = loop, 0 = play once
;   +7: TITLE    (32B)   - ASCII title shown on screen
;
; VERA PCM Hardware registers:
;   VERA_AUDIO_CTRL = VERA_BASE + $1B
;     Bit 7: FIFO Full (read) / FIFO Reset (write)
;     Bit 6: FIFO Empty (read) / FIFO Restart (write)
;     Bits 5:4: Format (0=mono 8-bit, 1=stereo 8-bit, 2=mono 16-bit, 3=stereo 16-bit)
;     Bits 3:0: Volume (0..15)
;   VERA_AUDIO_RATE = VERA_BASE + $1C
;     Playback sample rate: Fs = (RATE / 128) * 48828.125 Hz
;   VERA_AUDIO_DATA = VERA_BASE + $1D
;     Push 1 byte into 4KB hardware FIFO
;
; Controls: ESC / Q = Exit, M = Mute, L = Toggle Loop
; Conventions: asm6502.mjs syntax, VERA_BASE injected, $2000 BRUN.
; ==============================================================================

* = $2000

JMP_START:
    JMP START
    NOP
    NOP

; Header fields patched by build script
PCM_LEN_L:   !byte 0
PCM_LEN_H:   !byte 0
RATE_VAL:    !byte 21         ; Default 8010 Hz (Rate reg 21)
LOOP_ENA:    !byte 1          ; Default loop enabled
TITLE_STR:
    ASC "VERA PCM PLAYER (8-BIT SIGNED) "
    !byte 0

; Zero-page pointers
PTR_L        = $06
PTR_H        = $07
REMAIN_L     = $08
REMAIN_H     = $09

START:
    SEI
    CLD
    LDA #$00
    STA VERA_IEN          ; Disable interrupts
    LDA #$01
    STA VERA_ISR          ; Clear pending IRQ
    STA KBD_STROBE

    ; 1. Reset VERA PCM hardware: format 0 (mono 8-bit), max vol 15
    LDA #$8F              ; Bit 7 = reset FIFO, Format 0, Volume 15
    STA VERA_AUDIO_CTRL
    LDA #$0F              ; Clear reset bit, keep Volume 15
    STA VERA_AUDIO_CTRL

    ; Set playback rate
    LDA RATE_VAL
    STA VERA_AUDIO_RATE

    ; 2. Initialize pointers & state
    LDA #$00
    STA MUTE_FLAG
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN
    STA TICK_ACC

    JSR RESET_SAMPLE_PTR

    ; 3. Draw text page UI
    JSR SHOW_UI

    ; 4. Pre-fill VERA 4KB FIFO before starting main playback loop
    JSR FEED_FIFO

MAIN_LOOP:
    ; 1. Feed any available FIFO space
    JSR FEED_FIFO

    ; 2. Update stopwatch / clock (tick based on 100 loops ~ rough or VSYNC)
    JSR UPDATE_TIMER
    JSR SHOW_STATUS

    ; 3. Check keyboard input
    LDA KBD_DATA
    BPL MAIN_LOOP
    STA KBD_STROBE
    AND #$7F

    CMP #$1B              ; ESC
    BEQ DO_EXIT_JMP
    CMP #$51              ; Q
    BEQ DO_EXIT_JMP
    CMP #$71              ; q
    BEQ DO_EXIT_JMP
    CMP #$4D              ; M
    BEQ DO_MUTE_JMP
    CMP #$6D              ; m
    BEQ DO_MUTE_JMP
    CMP #$4C              ; L
    BEQ DO_LOOP_JMP
    CMP #$6C              ; l
    BEQ DO_LOOP_JMP

    JMP MAIN_LOOP

DO_EXIT_JMP:
    JMP DO_EXIT
DO_MUTE_JMP:
    JMP TOGGLE_MUTE
DO_LOOP_JMP:
    JMP TOGGLE_LOOP

; --------------------------------------------------------------------------
; Feed bytes into VERA hardware FIFO until FIFO is full (Bit 7 of CTRL = 1)
; or sample data is exhausted
; --------------------------------------------------------------------------
FEED_FIFO:
FEED_NEXT:
    ; Check if VERA FIFO is full
    LDA VERA_AUDIO_CTRL
    BMI FEED_DONE         ; Bit 7 = 1: FIFO is FULL (4095 bytes)

    ; Check if all bytes of sample have been sent
    LDA REMAIN_L
    ORA REMAIN_H
    BNE SEND_BYTE

    ; Sample reached end! Check if loop enabled
    LDA LOOP_ENA
    BEQ CHECK_DRAIN       ; If loop disabled, let FIFO drain to finish

    ; Loop is enabled: reset sample pointers back to beginning
    JSR RESET_SAMPLE_PTR
    JMP SEND_BYTE

CHECK_DRAIN:
    ; Check if FIFO has drained completely (Bit 6 = 1: FIFO Empty)
    LDA VERA_AUDIO_CTRL
    AND #$40
    BNE PLAY_FINISHED     ; FIFO empty and no loop -> finished!
    RTS

PLAY_FINISHED:
    LDA #$00
    STA VERA_AUDIO_RATE   ; Stop audio clock
    RTS

SEND_BYTE:
    LDY #$00
    LDA (PTR_L),Y
    STA VERA_AUDIO_DATA   ; Push sample into FIFO!

    ; Decrement remaining count
    LDA REMAIN_L
    BNE DEC_L
    DEC REMAIN_H
DEC_L:
    DEC REMAIN_L

    ; Increment pointer
    INC PTR_L
    BNE FEED_NEXT
    INC PTR_H
    JMP FEED_NEXT

FEED_DONE:
    RTS

; --------------------------------------------------------------------------
; Reset sample pointers to start of PCM_DATA
; --------------------------------------------------------------------------
RESET_SAMPLE_PTR:
    LDA #<PCM_DATA
    STA PTR_L
    LDA #>PCM_DATA
    STA PTR_H
    LDA PCM_LEN_L
    STA REMAIN_L
    LDA PCM_LEN_H
    STA REMAIN_H
    RTS

; --------------------------------------------------------------------------
; Mute / Unmute
; --------------------------------------------------------------------------
TOGGLE_MUTE:
    LDA MUTE_FLAG
    BNE DO_UNMUTE
    LDA #$01
    STA MUTE_FLAG
    LDA #$00              ; Volume 0
    STA VERA_AUDIO_CTRL
    JMP MAIN_LOOP
DO_UNMUTE:
    LDA #$00
    STA MUTE_FLAG
    LDA #$0F              ; Volume 15
    STA VERA_AUDIO_CTRL
    JMP MAIN_LOOP

; --------------------------------------------------------------------------
; Toggle Loop
; --------------------------------------------------------------------------
TOGGLE_LOOP:
    LDA LOOP_ENA
    EOR #$01
    STA LOOP_ENA
    JMP MAIN_LOOP

; --------------------------------------------------------------------------
; Exit back to ProDOS
; --------------------------------------------------------------------------
DO_EXIT:
    LDA #$00
    STA VERA_AUDIO_RATE   ; Stop audio clock
    LDA #$80
    STA VERA_AUDIO_CTRL   ; Reset FIFO / silence
    RTS

; --------------------------------------------------------------------------
; UI Screen display
; --------------------------------------------------------------------------
SHOW_UI:
    ; Row 0: Title
    LDY #$00
UI_T_LOOP:
    LDA TITLE_STR,Y
    BEQ UI_T_DONE
    ORA #$80
    STA $0400,Y
    INY
    CPY #40
    BNE UI_T_LOOP
UI_T_DONE:

    ; Row 1: Sample Rate & Controls
    LDY #$00
UI_R1_LOOP:
    LDA UI_LINE1,Y
    BEQ UI_R1_DONE
    ORA #$80
    STA $0480,Y
    INY
    BNE UI_R1_LOOP
UI_R1_DONE:

    ; Row 2: Keys
    LDY #$00
UI_R2_LOOP:
    LDA UI_LINE2,Y
    BEQ UI_R2_DONE
    ORA #$80
    STA $0500,Y
    INY
    BNE UI_R2_LOOP
UI_R2_DONE:
    RTS

SHOW_STATUS:
    ; Row 23 ($07D0): "T: mm:ss.s  B: xxxx  L:ON  M_"
    ; "T: "
    LDA #$D4              ; 'T'
    STA $07D0
    LDA #$BA              ; ':'
    STA $07D1
    LDA #$A0              ; ' '
    STA $07D2

    ; Minute tens & ones
    LDA CLK_MIN
    JSR HEX_TO_DEC
    STA $07D3
    TXA
    STA $07D4

    LDA #$BA              ; ':'
    STA $07D5

    ; Second tens & ones
    LDA CLK_SEC
    JSR HEX_TO_DEC
    STA $07D6
    TXA
    STA $07D7

    LDA #$AE              ; '.'
    STA $07D8

    ; Tenths of a second
    LDA CLK_FRM
    JSR FRM_TO_TENTH
    STA $07D9

    LDA #$A0              ; ' '
    STA $07DA
    STA $07DB

    ; Loop status: "LOOP:ON " or "LOOP:OFF"
    LDA #$CC              ; 'L'
    STA $07DC
    LDA #$BA              ; ':'
    STA $07DD
    LDA LOOP_ENA
    BEQ DISP_LOOP_OFF
    LDA #$CF              ; 'O'
    STA $07DE
    LDA #$CE              ; 'N'
    STA $07DF
    LDA #$A0
    STA $07E0
    JMP DISP_MUTE
DISP_LOOP_OFF:
    LDA #$CF              ; 'O'
    STA $07DE
    LDA #$C6              ; 'F'
    STA $07DF
    STA $07E0

DISP_MUTE:
    LDA #$A0
    STA $07E1
    LDA MUTE_FLAG
    BEQ DISP_MUTED_NO
    LDA #$CD              ; 'M'
    STA $07E2
    LDA #$A1              ; '!'
    STA $07E3
    RTS
DISP_MUTED_NO:
    LDA #$A0
    STA $07E2
    STA $07E3
    RTS

; --------------------------------------------------------------------------
; Timer update
; --------------------------------------------------------------------------
UPDATE_TIMER:
    ; Wait for VSYNC bit in VERA_ISR for accurate 60Hz timing
    LDA VERA_ISR
    AND #$01
    BEQ TIMER_DONE
    LDA #$01
    STA VERA_ISR          ; Acknowledge VSYNC

    INC CLK_FRM
    LDA CLK_FRM
    CMP #60
    BNE TIMER_DONE
    LDA #$00
    STA CLK_FRM

    INC CLK_SEC
    LDA CLK_SEC
    CMP #60
    BNE TIMER_DONE
    LDA #$00
    STA CLK_SEC

    INC CLK_MIN
    LDA CLK_MIN
    CMP #60
    BNE TIMER_DONE
    LDA #$00
    STA CLK_MIN
TIMER_DONE:
    RTS

HEX_TO_DEC:
    LDX #$B0              ; '0'
DIV10_LOOP:
    CMP #10
    BCC DIV10_DONE
    SBC #10
    INX
    BNE DIV10_LOOP
DIV10_DONE:
    ORA #$B0              ; ones digit
    PHA
    TXA
    TAY
    PLA
    TAX
    TYA
    RTS

FRM_TO_TENTH:
    ; CLK_FRM (0..59) / 6 -> tenths (0..9)
    LDX #$B0
TENTH_LOOP:
    CMP #6
    BCC TENTH_DONE
    SBC #6
    INX
    BNE TENTH_LOOP
TENTH_DONE:
    TXA
    RTS

; --------------------------------------------------------------------------
; Strings & State
; --------------------------------------------------------------------------
UI_LINE1:
    ASC "FORMAT: 8-BIT MONO PCM  FIFO: 4096B"
    !byte 0
UI_LINE2:
    ASC "ESC/Q=EXIT  M=MUTE  L=LOOP"
    !byte 0

MUTE_FLAG: !byte 0
CLK_FRM:   !byte 0
CLK_SEC:   !byte 0
CLK_MIN:   !byte 0
TICK_ACC:  !byte 0

; --------------------------------------------------------------------------
; PCM Sample Data Starts Here
; --------------------------------------------------------------------------
PCM_DATA:
