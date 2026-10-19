; ==============================================================================
; ZSMSTREAM.ASM — Apple II ZSM Jukebox Player (VERA PSG + YM2151 FM)
; Companion to zsmplay.asm (M31 embedded FM demo). Streams a real ZSM song
; from a ProDOS file, decoding PSG writes + YM2151 batches into a double
; frame buffer that the VERA IRQ applies once per VSYNC frame.
;
; ZSM format (see ZSM Format Specification.md):
;   header: magic 'zm', ver 1, loopOffset 24-bit (0 = no loop), pcmOffset 24-bit
;           fmMask, psgMask 16-bit, tickRate 16-bit
;   stream: $00-$3F PSG write [reg,val]
;           $40     EXTCMD [ext] (bits7:6 channel; skip payload)
;           $41-$7F YM batch (count=cmd&$3F, then count x [reg,val])
;           $80     end of song
;           $81-$FF delay n ticks
;
; Decoder runs in the main loop (never in IRQ): MLI is not re-entrant, so all
; disk I/O and decoding happen here. The IRQ only reads the published frame.
;
; Frame buffer (double-buffered, ping-pong):
;   [psgCnt][reg,val]x psgCnt [ymCnt][reg,val]x ymCnt   (psgCnt=$FF = hold frame)
;   Decoder builds the next frame in the write buffer; on a frame boundary it
;   waits for FB_READY==0, publishes FB_ACT=base, FB_READY=1, then swaps buffers.
;   IRQ consumes the published frame, applies PSG (VRAM $F9C0) + YM ($Cs21), and
;   clears FB_READY.
;
; Controls (in song): ESC/Q = stop -> menu, P/space = pause, M = mute,
;   +/- = vol, ]/[ = forward/backward 5 s, R = restart, L = loop toggle.
; Menu: digit 1-9,0 selects song; ESC/Q exits to BASIC (RTS). STARTUP can
; preselect the song by POKEing 1..11 to $6800 (sentinel, read+cleared).
; AUTOPLAY = 1 (injected via --autoplay build) auto-starts song 0 for headless.
;
; Conventions: asm6502.mjs syntax, VERA_BASE injected ($C200 slot2/$C400 slot4),
; $2000 BRUN, dual slot. Code below $3800. Zero page $06-$2D.
; ==============================================================================

* = $2000

MLI         = $BF00
STREAM_L = $06       ; feeder pointer into $4000 buffer (zp)
STREAM_H = $07
CNT      = $08
FRAC     = $09       ; tick-rate accumulator (60Hz normalize)
TICKRATE = $0A       ; ZSM tick rate (header byte 12; all songs = 60)
FMMASK   = $0B       ; YM2151 channel mask (header byte 9)
PSGMASK_L= $0C       ; PSG voice mask low (header byte 10)
PSGMASK_H= $0D       ; PSG voice mask high (header byte 11)
LOOP_OFF_L = $0E     ; loop byte offset (header bytes 3-5)
LOOP_OFF_M = $0F
LOOP_OFF_H = $10
CHAN_TMP = $11
MASK_TMP = $12
REG_TMP  = $13       ; current YM reg being decoded
VAL_TMP  = $14       ; current value being decoded
CMD      = $15       ; current stream command byte
FB_ACT_L = $16       ; IRQ: published frame pointer (zp)
FB_ACT_H = $17
FB_READY = $18       ; 1 = frame available for IRQ
SAV_L    = $19       ; IRQ VERA_ADDR save
SAV_M    = $1A
SAV_H    = $1B
SAV_CTRL = $1C       ; IRQ VERA_CTRL save
FRAME_L  = $1D       ; decoder frame base (write buffer)
FRAME_H  = $1E
NAME_PTR_L = $1F     ; song name pointer (BFP_NAME_LOOP)
NAME_PTR_H = $20
DM_ADDR_L = $21      ; menu draw pointer
DM_ADDR_H = $22
DM_TITLE_PTR_L = $23 ; menu title pointer
DM_TITLE_PTR_H = $24
WRB_PTR_L = $25      ; write-buffer write pointer
WRB_PTR_H = $26
WRB_BASE_L = $27     ; current write-buffer base
WRB_BASE_H = $28
PSG_CNT  = $29       ; decoder PSG pair count (current frame)
YM_CNT   = $2A       ; decoder YM pair count (current frame)
YMCNT_POS_L = $2B    ; addr of ymCnt byte in frame (or $FF = none yet)
YMCNT_POS_H = $2C
HOLD_LEFT = $2D      ; remaining hold frames to publish for a delay
YMSCR_L = $2E        ; YM pair accumulation pointer (low)
YMSCR_H = $2F        ; (high)
MOVSRC_L = $30       ; memmove source (low, = YM_SCRATCH)
MOVSRC_H = $31       ; (high)
MOVDST_L = $32       ; memmove dest (low, = FRAME + 2*psgCnt + 2)
MOVDST_H = $33       ; (high)
MOVCNT  = $34        ; memmove byte count (2*ymCnt, low)
MOVCNT_H = $35       ; (high) -- 2*ymCnt can exceed 255

BUF_LO  = $4000      ; 512-byte stream block buffer
BUF_HI  = $4200
FB_A    = $7300      ; frame buffer A (512 B)  -- above ProDOS resident code + file buf
FB_B    = $7500      ; frame buffer B (512 B)  -- 512 B apart from FB_A (no overlap)
YM_SCRATCH = $7700   ; YM pair accumulation buffer (512 B)  -- 512 B apart from FB_B
FILE_BUF = $6000
PCM_BUFFER = $4400   ; PCM sample staging buffer (7168 B) -- free RAM below FB_A
PCM_BUFFER_SIZE = $1C00  ; 7168 bytes (PCM_BUFFER..PCM_BUFFER+SIZE-1)
PCM_FILE_BUF = $6400 ; PCM refnum FCB (1024 B) -- free RAM below FILE_BUF+$400
SEL_SENTINEL = $6800 ; STARTUP's POKE 26624,N (N=1..11 song preselect, cleared)

AUTOPLAY = 0         ; release: menu only. --autoplay build injects AUTOPLAY=1.
AUTOSONG = 0         ; which song index AUTOPLAY auto-starts (injectable).

; FM daughterboard host registers (local — not in vera.inc)
YM_REG  = VERA_BASE + $20   ; YM_REG select
YM_DATA = VERA_BASE + $21   ; YM_DATA write (read = status)

START:
    SEI
    CLD                   ; ADC below assumes binary mode
    ; Normalize display banking for the 40-col PAGE1 text UI below.
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

    JSR SILENCE_ALL        ; PSG regs -> 0
    JSR FM_KEY_OFF         ; YM ch0-7 key off
    LDA #15
    STA MASTER_VOL
    LDA #$00
    STA FRM0
    STA FRM1
    STA FRM2
    STA MUTE
    STA PAUSE
    STA ERR
    STA DONE_FLAG
    STA IRQ_ACTIVE
    STA REF_NUM
    STA PCM_ACTIVE
    STA PCM_REF
    LDA #$FF
    STA PCM_LOADED

MENU:
    JSR CLEAR_SCREEN
    JSR DRAW_MENU
    LDA #AUTOPLAY
    BEQ MENU_PRE
    ; autoplay build: ignore the preselect sentinel, play AUTOSONG
    LDA #AUTOSONG
    STA SONG_NUM
    JMP PLAY_SONG
MENU_PRE:
    ; preselect sentinel at $6800 (STARTUP POKE 26624): 1..11 -> song
    LDA $6800
    BEQ MENU_WAIT_KEY
    CMP #$0C
    BCS MENU_PRE_BAD
    SEC
    SBC #$01
    STA SONG_NUM
    LDA #$00
    STA $6800
    JMP PLAY_SONG
MENU_PRE_BAD:
    LDA #$00
    STA $6800
MENU_WAIT_KEY:
    LDA KBD_DATA
    BPL MENU_WAIT_KEY
    STA KBD_STROBE
    AND #$7F
    CMP #$1B              ; ESC
    BEQ DO_EXIT_JMP
    CMP #$51              ; Q
    BEQ DO_EXIT_JMP
    CMP #$71              ; q
    BEQ DO_EXIT_JMP
    CMP #$53              ; 'S' -> song 11 (index 10, Shovel Knight)
    BEQ MENU_SHOVEL
    CMP #$73              ; 's'
    BEQ MENU_SHOVEL
    CMP #$30              ; '0' -> song 10 (index 9)
    BEQ MENU_ZERO
    CMP #$31              ; '1'..'9'
    BCC MENU_WAIT_KEY
    CMP #$3A
    BCS MENU_WAIT_KEY
    SEC
    SBC #$31              ; '1'->0 .. '9'->8
    STA SONG_NUM
    JMP PLAY_SONG
MENU_ZERO:
    LDA #$09
    STA SONG_NUM
    JMP PLAY_SONG
MENU_SHOVEL:
    LDA #10
    STA SONG_NUM
    JMP PLAY_SONG
DO_EXIT_JMP:
    JMP DO_EXIT

; --------------------------------------------------------------------------
; PLAY_SONG — open the selected ZSM, read header, prefill 1 frame, hook IRQ
; --------------------------------------------------------------------------
PLAY_SONG:
    JSR CLEAR_SCREEN
    ; Resolve song name pointer: NAME_PTR = NAME_TBL[SONG_NUM]
    LDA SONG_NUM
    ASL A                 ; *2
    TAY
    LDA NAME_TBL,Y
    STA NAME_PTR_L
    LDA NAME_TBL+1,Y
    STA NAME_PTR_H
    LDA #$00
    STA ERR
    STA STREAM_END
    STA DONE_FLAG
    STA FRAC
    STA HOLD_LEFT
    STA MUTE
    STA PAUSE
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN
    STA FRM0
    STA FRM1
    STA FRM2
    LDA #$01
    STA LOOP_EN
    ; Init the stream feeder so the first GETB refills into $4000.
    ; (STREAM_L/H and BUF_END are only set by REFILL; without this, the first
    ; GETB's exhaustion check compares garbage STREAM_H vs garbage BUF_END_H.)
    LDA #<BUF_LO
    STA STREAM_L
    LDA #>BUF_LO
    STA STREAM_H
    LDA #$00
    STA BUF_END_L
    STA BUF_END_H
    JSR OPEN_STREAM
    LDA ERR
    BEQ POF1_OK
    JMP PLAY_OPEN_FAIL
POF1_OK:
    JSR READ_HEADER
    LDA ERR
    BEQ POF2_OK
    JMP PLAY_OPEN_FAIL
POF2_OK:
    JSR CLEAR_SHADOW
    ; Initialize write-buffer base to FB_A before the first decode.
    LDA #$00
    STA WRB_BASE_L
    LDA #$73              ; FB_A high byte
    STA WRB_BASE_H
    ; Prefill 1 frame (IRQ not hooked yet; IRQ_ACTIVE=0 -> publish no-wait)
    JSR DECODE_FRAME
    JSR IRQ_ON
    LDA #$01
    STA IRQ_ACTIVE

MAIN:
    LDA DONE_FLAG
    BNE SONG_DONE_JMP
    LDA ERR
    BNE DISK_FAIL_JMP
    JSR DECODE_FRAME
    JSR SHOW_STATUS
    ; Keyboard
    LDA KBD_DATA
    BPL MAIN
    STA KBD_STROBE
    AND #$7F
    CMP #$1B
    BEQ SONG_EXIT_JMP
    CMP #$51
    BEQ SONG_EXIT_JMP
    CMP #$71
    BEQ SONG_EXIT_JMP
    CMP #$50              ; P
    BEQ DO_PAUSE_JMP
    CMP #$70
    BEQ DO_PAUSE_JMP
    CMP #$4D              ; M
    BEQ DO_MUTE_JMP
    CMP #$6D
    BEQ DO_MUTE_JMP
    CMP #$2B              ; +
    BEQ DO_VOL_UP_JMP
    CMP #$3D              ; =
    BEQ DO_VOL_UP_JMP
    CMP #$2D              ; -
    BEQ DO_VOL_DOWN_JMP
    CMP #$5F              ; _
    BEQ DO_VOL_DOWN_JMP
    CMP #$5D              ; ] (forward 5 s)
    BEQ DO_SEEK_FWD_JMP
    CMP #$6B
    BEQ DO_SEEK_FWD_JMP
    CMP #$5B              ; [ (backward 5 s)
    BEQ DO_SEEK_BWD_JMP
    CMP #$63
    BEQ DO_SEEK_BWD_JMP
    CMP #$52              ; R restart
    BEQ DO_RESTART_JMP
    CMP #$72
    BEQ DO_RESTART_JMP
    CMP #$4C              ; L loop toggle
    BEQ DO_LOOP_JMP
    CMP #$6C
    BEQ DO_LOOP_JMP
    CMP #$A0              ; space
    BEQ DO_PAUSE_JMP
    JMP MAIN
SONG_DONE_JMP:
    JMP SONG_DONE
DISK_FAIL_JMP:
    JMP DISK_FAIL
SONG_EXIT_JMP:
    JMP SONG_EXIT
DO_PAUSE_JMP:
    JMP DO_PAUSE
DO_MUTE_JMP:
    JMP DO_MUTE
DO_VOL_UP_JMP:
    JMP DO_VOL_UP
DO_VOL_DOWN_JMP:
    JMP DO_VOL_DOWN
DO_SEEK_FWD_JMP:
    JMP DO_SEEK_FWD
DO_SEEK_BWD_JMP:
    JMP DO_SEEK_BWD
DO_RESTART_JMP:
    JMP DO_RESTART
DO_LOOP_JMP:
    JMP DO_LOOP

PLAY_OPEN_FAIL:
    JSR SHOW_STATUS
    JMP DISK_FAIL

; --------------------------------------------------------------------------
; READ_HEADER — consume the 16-byte ZSM header via GETB into the mask vars
; --------------------------------------------------------------------------
READ_HEADER:
    JSR GETB               ; magic 'z'
    JSR GETB               ; 'm'
    JSR GETB               ; version
    JSR GETB               ; loopOffset low
    STA LOOP_OFF_L
    JSR GETB
    STA LOOP_OFF_M
    JSR GETB
    STA LOOP_OFF_H
    JSR GETB               ; pcm offset low
    STA PCM_TBL_L
    JSR GETB
    STA PCM_TBL_M
    JSR GETB
    STA PCM_TBL_H
    JSR GETB               ; fmMask
    STA FMMASK
    JSR GETB               ; psgMask low
    STA PSGMASK_L
    JSR GETB               ; psgMask high
    STA PSGMASK_H
    JSR GETB               ; tickRate low
    STA TICKRATE
    JSR GETB               ; tickRate high (all songs 60 -> ignore)
    JSR GETB               ; reserved (header offset 0x0e)
    JSR GETB               ; reserved (header offset 0x0f)
    ; Set up PCM if the song has a PCM table (pcmTableOffset != 0).
    JSR READ_PCM_SETUP
    LDA STREAM_END
    BEQ RH_DONE
    LDA #$01
    STA ERR
RH_DONE:
    RTS

; --------------------------------------------------------------------------
; DECODE_FRAME — decode events for one frame, publish when a boundary hits.
; If HOLD_LEFT > 0 (a delay is in progress), publish one hold frame instead.
; Returns after one publish; the caller loops. EOD -> DONE_FLAG.
; --------------------------------------------------------------------------
DECODE_FRAME:
    LDA HOLD_LEFT
    BEQ DF_NORMAL
    JSR PUBLISH_HOLD
    DEC HOLD_LEFT
    RTS
DF_NORMAL:
    JSR FRAME_START
    LDA STREAM_END
    BEQ DF_LOOP
    JMP DF_END
DF_LOOP:
    JSR GETB
    STA CMD
    LDA STREAM_END
    BEQ DF_LOOP2
    JMP DF_END
DF_LOOP2:
    LDA CMD
    CMP #$40
    BNE DF_D1
    JMP DF_EXT
DF_D1:
    CMP #$80
    BNE DF_D2
    JMP DF_EOD
DF_D2:
    CMP #$41
    BCC DF_PSG            ; $00-$3F PSG write
    CMP #$81
    BCC DF_D4
    JMP DF_DELAY          ; $81-$FF delay
DF_D4:
    ; $41-$7F YM batch
    AND #$3F
    STA CNT
DF_YM_L:
    JSR GETB              ; reg
    STA REG_TMP
    JSR GETB              ; val
    STA VAL_TMP
    LDA STREAM_END
    BEQ DF_YM2
    JMP DF_END
DF_YM2:
    JSR YM_MASK_GATE
    BCC DF_SKIP_YM
    LDA REG_TMP
    JSR ADD_YM_PAIR
DF_SKIP_YM:
    DEC CNT
    BNE DF_YM_L
    JMP DF_LOOP
DF_PSG:
    JSR GETB              ; val
    STA VAL_TMP
    LDA STREAM_END
    BEQ DF_PSG2
    JMP DF_END
DF_PSG2:
    JSR PSG_MASK_GATE
    BCC DF_SKIP_PSG
    LDA CMD
    JSR ADD_PSG_PAIR
DF_SKIP_PSG:
    JMP DF_LOOP
DF_EXT:
    JSR GETB              ; ext
    STA VAL_TMP
    LDA STREAM_END
    BEQ DF_EXT2
    JMP DF_END
DF_EXT2:
    LDA VAL_TMP
    CMP #$40
    BCS DF_EXT_SYNC
    ; ext < $40: PCM sub-events (only if this song has a PCM table)
    LDA PCM_TBL_L
    ORA PCM_TBL_M
    ORA PCM_TBL_H
    BEQ DF_EXT_PCM_SKIP
    LDA VAL_TMP
    LSR A                ; nEvents = ext / 2
    STA PCM_EVCOUNT
    BEQ DF_EXT_ODD
DF_EXT_PCM_L:
    JSR GETB              ; sub
    STA PCM_SUB
    JSR GETB              ; val
    STA PCM_VAL
    LDA STREAM_END
    BEQ DF_EXT_PCM2
    JMP DF_END
DF_EXT_PCM2:
    JSR PCM_APPLY_EVENT
    LDA ERR
    BNE DF_EXT_ERR
    DEC PCM_EVCOUNT
    BNE DF_EXT_PCM_L
DF_EXT_ODD:
    LDA VAL_TMP
    AND #$01
    BEQ DF_EXT_DONE
    JSR GETB              ; odd trailing byte (skip to stay in sync)
    LDA STREAM_END
    BEQ DF_EXT_DONE
    JMP DF_END
DF_EXT_DONE:
    JMP DF_LOOP
DF_EXT_ERR:
    JMP DF_END
DF_EXT_SYNC:
    ; ext >= $40: channel 1/2/3 event. Skip ext&$3F payload bytes.
    AND #$3F
    JSR DF_SKIP_BYTES
    JMP DF_LOOP
DF_EXT_PCM_SKIP:
    ; No PCM table: consume the payload (ext bytes + odd trailing) but
    ; don't apply events.
    LDA VAL_TMP
    JSR DF_SKIP_BYTES
    JMP DF_LOOP

; DF_SKIP_BYTES — A = count; skip that many bytes (GETB each). No odd-trailing
; here; the PCM path handles its own odd byte. Clobbers A/Y.
DF_SKIP_BYTES:
    TAX
    BEQ DFSB_RTS
DF_SKIP_L:
    JSR GETB
    LDA STREAM_END
    BEQ DFSB2
    JMP DF_END
DFSB2:
    DEX
    BNE DF_SKIP_L
DFSB_RTS:
    RTS
DF_DELAY:
    LDA CMD
    AND #$7F
    SEC
    SBC #$01
    STA HOLD_LEFT
    JSR PUBLISH_FRAME
    RTS
DF_EOD:
    JSR PUBLISH_FRAME
    LDA #$14
    STA DEBUG_MARKER
    LDA LOOP_OFF_L
    ORA LOOP_OFF_M
    ORA LOOP_OFF_H
    BEQ DF_DONE           ; no loop -> song over
    LDA LOOP_EN
    BEQ DF_DONE           ; loop disabled -> song over
    JSR DO_LOOP_SEEK
    RTS
DF_END:
    JSR PUBLISH_FRAME
    LDA #$15
    STA DEBUG_MARKER
    LDA #$01
    STA DONE_FLAG
DF_DONE:
    RTS
DF_END_JMP:
    JMP DF_END

; --------------------------------------------------------------------------
; PSG_MASK_GATE — C=1 if reg (CMD) channel is enabled by psgMask. Clobbers A.
; --------------------------------------------------------------------------
PSG_MASK_GATE:
    LDA CMD
    LSR A
    LSR A                 ; channel 0..15
    STA CHAN_TMP
    CMP #$08
    BCS PMG_HI
    LDA PSGMASK_L
    JMP PMG_GOT
PMG_HI:
    LDA PSGMASK_H
PMG_GOT:
    STA MASK_TMP
    LDA CHAN_TMP
    AND #$07
    TAX
    LDA BIT_TBL,X
    AND MASK_TMP
    BNE PMG_ON
    CLC                   ; masked
    RTS
PMG_ON:
    SEC                   ; enabled
    RTS

; --------------------------------------------------------------------------
; YM_MASK_GATE — C=1 if YM reg/val channel is enabled by fmMask. Clobbers A.
;   reg >= $20: channel = reg & 7
;   reg == $08: channel = val & 7
;   other regs (< $20, != $08): never masked
; --------------------------------------------------------------------------
YM_MASK_GATE:
    LDA REG_TMP
    CMP #$20
    BCS YMG_CHAN
    CMP #$08
    BEQ YMG_KEYON
    SEC                   ; global reg: always enabled
    RTS
YMG_KEYON:
    LDA VAL_TMP
    AND #$07
    STA CHAN_TMP
    JMP YMG_TEST
YMG_CHAN:
    LDA REG_TMP
    AND #$07
    STA CHAN_TMP
YMG_TEST:
    LDA CHAN_TMP
    AND #$07
    TAX
    LDA BIT_TBL,X
    AND FMMASK
    BNE YMG_ON
    CLC
    RTS
YMG_ON:
    SEC
    RTS

BIT_TBL:
    !byte 1,2,4,8,$10,$20,$40,$80

; --------------------------------------------------------------------------
; Frame-buffer builders (main loop only). Frame layout at WRB_PTR:
;   [psgCnt][psg pairs][ymCnt][ym pairs]  (psgCnt=$FF = hold)
; --------------------------------------------------------------------------
FRAME_START:
    LDA WRB_BASE_L
    STA FRAME_L
    STA WRB_PTR_L
    LDA WRB_BASE_H
    STA FRAME_H
    STA WRB_PTR_H
    LDA #$00
    STA PSG_CNT
    STA YM_CNT
    LDA #$77             ; YM accumulation starts at YM_SCRATCH
    STA YMSCR_H
    LDA #$00
    STA YMSCR_L
    LDY #$00
    STA (WRB_PTR_L),Y     ; psgCnt placeholder = 0
    INC WRB_PTR_L
    BNE FS_OK
    INC WRB_PTR_H
FS_OK:
    RTS

ADD_PSG_PAIR:
    ; A = reg, VAL_TMP = val
    STA REG_TMP
    LDY #$00
    LDA REG_TMP
    STA (WRB_PTR_L),Y
    INC WRB_PTR_L
    BNE AP_OK1
    INC WRB_PTR_H
AP_OK1:
    LDA VAL_TMP
    STA (WRB_PTR_L),Y
    INC WRB_PTR_L
    BNE AP_OK2
    INC WRB_PTR_H
AP_OK2:
    INC PSG_CNT
    RTS

ADD_YM_PAIR:
    ; A = reg, VAL_TMP = val. YM pairs accumulate in YM_SCRATCH ($4C00),
    ; separate from the PSG section; PUBLISH_FRAME copies them into place
    ; right after the PSG section (the IRQ reads a fixed [psg][ym] layout).
    STA REG_TMP
    LDY #$00
    LDA REG_TMP
    STA (YMSCR_L),Y
    INC YMSCR_L
    BNE AY_OK1
    INC YMSCR_H
AY_OK1:
    LDA VAL_TMP
    STA (YMSCR_L),Y
    INC YMSCR_L
    BNE AY_OK2
    INC YMSCR_H
AY_OK2:
    INC YM_CNT
    RTS

PUBLISH_HOLD:
    LDA WRB_BASE_L
    STA FRAME_L
    LDA WRB_BASE_H
    STA FRAME_H
    LDA #$FF
    STA PSG_CNT           ; psgCnt = $FF (hold) -> PUBLISH_FRAME writes it
    JMP PUBLISH_FRAME

; --------------------------------------------------------------------------
; PUBLISH_FRAME — finalize frame, wait FB_READY==0 (if IRQ active), set
; FB_ACT=base, FB_READY=1, swap write buffer.
; --------------------------------------------------------------------------
PUBLISH_FRAME:
    LDA #$00
    STA PCM_FED_L
    STA PCM_FED_H
    LDA IRQ_ACTIVE
    BEQ PUB_NOWAIT
PUB_WAIT:
    JSR FEED_PCM
    LDA FB_READY
    BNE PUB_WAIT
PUB_NOWAIT:
    LDY #$00
    LDA PSG_CNT
    CMP #$FF
    BNE PUB_NORMAL        ; normal frame
    ; hold frame: psgCnt=$FF at @0, skip the rest
    LDA #$FF
    STA (FRAME_L),Y
    JMP PUB_SWAP
PUB_NORMAL:
    ; normal frame: @0 = psgCnt
    STA (FRAME_L),Y
    ; MOVDST = FRAME + 2*psgCnt + 1  (ymCnt position)
    LDA PSG_CNT
    ASL A
    CLC
    ADC #$01
    STA MOVDST_L
    LDA #$00
    STA MOVDST_H
    LDA MOVDST_L
    CLC
    ADC FRAME_L
    STA MOVDST_L
    LDA MOVDST_H
    ADC FRAME_H
    STA MOVDST_H
    LDA YM_CNT
    STA (MOVDST_L),Y      ; write ymCnt
    INC MOVDST_L          ; now points at first YM pair dest
    BNE PUB_INC1
    INC MOVDST_H
PUB_INC1:
    ; move 2*ymCnt bytes from YM_SCRATCH to MOVDST (contiguous YM section)
    ; 2*ymCnt is a 16-bit count -- GAMEOVER hits 213 YM pairs (426 bytes)
    LDA YM_CNT
    ASL A
    STA MOVCNT
    LDA #$00
    ADC #$00              ; carry from ASL
    STA MOVCNT_H
    LDA MOVCNT
    ORA MOVCNT_H
    BEQ PUB_SWAP          ; no YM pairs
    LDA #$77
    STA MOVSRC_H
    LDA #$00
    STA MOVSRC_L
PUB_MOVE:
    LDY #$00
    LDA (MOVSRC_L),Y
    STA (MOVDST_L),Y
    INC MOVSRC_L
    BNE PUB_M1
    INC MOVSRC_H
PUB_M1:
    INC MOVDST_L
    BNE PUB_M2
    INC MOVDST_H
PUB_M2:
    LDA MOVCNT
    BNE PUB_DEC        ; L != 0: decrement L only
    LDA MOVCNT_H
    BEQ PUB_SWAP       ; done (count == 0)
    ; L == 0, H > 0: borrow — dec H, L rolls to $FF
    DEC MOVCNT_H
    LDA #$FF
    STA MOVCNT
    JMP PUB_MOVE
PUB_DEC:
    SEC
    SBC #$01
    STA MOVCNT
    JMP PUB_MOVE
PUB_SWAP:
    SEI
    LDA FRAME_L
    STA FB_ACT_L
    LDA FRAME_H
    STA FB_ACT_H
    LDA #$01
    STA FB_READY
    ; swap write buffer (alternate FB_A / FB_B by high byte)
    LDA WRB_BASE_H
    CMP #$75              ; currently FB_B?
    BNE PUB_TO_A
    LDA #$00
    STA WRB_BASE_L
    LDA #$73              ; FB_A high byte
    STA WRB_BASE_H
    JMP PUB_SWAP_DONE
PUB_TO_A:
    LDA #$00
    STA WRB_BASE_L
    LDA #$75              ; FB_B high byte
    STA WRB_BASE_H
PUB_SWAP_DONE:
    CLI
    RTS

; --------------------------------------------------------------------------
; DO_LOOP_SEEK — repoint the file cursor to loopOffset (absolute byte offset),
; refill, and continue decoding. Engine state (PSG/YM regs) is NOT reset
; (zsmkit semantics). One-frame IRQ gap is natural (hardware sustains).
; --------------------------------------------------------------------------
DO_LOOP_SEEK:
    LDA #$11
    STA DEBUG_MARKER
    LDA LOOP_OFF_L
    STA SETMARK_PARAMS+2
    LDA LOOP_OFF_M
    STA SETMARK_PARAMS+3
    LDA LOOP_OFF_H
    STA SETMARK_PARAMS+4
    JSR SEEK_TO
    BCC DLS_OK
    RTS                   ; ERR=1 -> MAIN reports DISK_FAIL
DLS_OK:
    LDA #$12
    STA DEBUG_MARKER
    RTS

; SEEK_TO — SETMARK_PARAMS+2..4 already hold the 24-bit target byte offset.
; Waits for FB_READY==0 (IRQ is idle), SET_MARKs the file cursor, refills.
; Returns CLC on success; on failure SEC + ERR=1 + DEBUG_MARKER=$13 (MAIN
; reports DISK_FAIL).  One-frame IRQ gap is natural (hardware sustains).
SEEK_TO:
    LDA IRQ_ACTIVE
    BEQ ST_NOWAIT
ST_WAIT:
    LDA FB_READY
    BNE ST_WAIT
ST_NOWAIT:
    LDA REF_NUM
    STA SETMARK_PARAMS+1
    JSR MLI
    !byte $CE              ; SET_MARK
    !word SETMARK_PARAMS
    BCC ST_MARK_OK
    STA ERRCODE
    LDA #$41
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
    LDA #$13
    STA DEBUG_MARKER
    SEC
    RTS
ST_MARK_OK:
    LDA #$00
    STA STREAM_END
    STA EOF_FLAG
    JSR REFILL
    LDA #$00
    STA STREAM_END
    CLC
    RTS

; --------------------------------------------------------------------------
; In-song seek / restart / loop (psgplay-style button controls)
; --------------------------------------------------------------------------

; SEEK_STEP — decode one ZSM frame without publishing it.  PSG pairs update
; SHADOW (gated by psgMask); YM pairs are discarded (every-frame rewrite:
; the next frame's YM batch rewrites them all); PCM sub-events are skipped.
; HOLD_LEFT frames are consumed like DECODE_FRAME does.  Returns CLC=frame
; consumed, continue; SEC=stop (STREAM_END / EOD handled by the caller
; policy).  Requires FB_READY==0 (main loop is idle: IRQ consumes nothing).
; Clobbers A/X/Y + zp vars shared with the decode path.
SEEK_STEP:
    LDA HOLD_LEFT
    BEQ SS_DECODE
    DEC HOLD_LEFT
    CLC
    RTS
SS_DECODE:
    JSR GETB
    STA CMD
    LDA STREAM_END
    BEQ SS_CMD
    SEC
    RTS
SS_CMD:
    LDA CMD
    CMP #$40
    BNE SS_D1
    JMP SS_EXT
SS_D1:
    CMP #$80
    BNE SS_D2
    JMP SS_EOD
SS_D2:
    CMP #$41
    BCC SS_PSG
    JMP SS_YM
SS_PSG:
    JSR GETB
    STA VAL_TMP
    LDA STREAM_END
    BEQ SS_PSG2
    SEC
    RTS
SS_PSG2:
    JSR PSG_MASK_GATE
    BCC SS_PSG_SKIP
    LDA VAL_TMP
    LDX CMD
    STA SHADOW,X
SS_PSG_SKIP:
    CLC
    RTS
SS_YM:
    AND #$3F
    STA CNT
SS_YM_L:
    JSR GETB              ; reg (discarded)
    JSR GETB              ; val (discarded)
    LDA STREAM_END
    BEQ SS_YM2
    SEC
    RTS
SS_YM2:
    DEC CNT
    BNE SS_YM_L
    CLC
    RTS
SS_EXT:
    JSR GETB
    STA VAL_TMP
    LDA STREAM_END
    BEQ SS_EXT2
    SEC
    RTS
SS_EXT2:
    LDA VAL_TMP
    CMP #$40
    BCS SS_EXT_SYNC
    ; ext < $40: skip 2*n PCM sub-event bytes (+ odd trailing byte).
    LDA VAL_TMP
    AND #$01
    STA PCM_SUB           ; stash odd flag (PCM_SUB free during seek)
    LDA VAL_TMP
    LSR A
    STA PCM_EVCOUNT
    BEQ SS_EXT_ODD
SS_EXT_L:
    JSR GETB
    LDA STREAM_END
    BEQ SS_EXT_L2
    SEC
    RTS
SS_EXT_L2:
    JSR GETB
    LDA STREAM_END
    BEQ SS_EXT_L3
    SEC
    RTS
SS_EXT_L3:
    DEC PCM_EVCOUNT
    BNE SS_EXT_L
SS_EXT_ODD:
    LDA PCM_SUB
    BEQ SS_EXT_DONE
    JSR GETB
    LDA STREAM_END
    BEQ SS_EXT_DONE2
    SEC
    RTS
SS_EXT_DONE2:
SS_EXT_DONE:
    CLC
    RTS
SS_EXT_SYNC:
    LDA VAL_TMP
    AND #$3F
    TAX
    BEQ SS_EXT_DONE
SS_SYNC_L:
    JSR GETB
    LDA STREAM_END
    BEQ SS_SYNC2
    SEC
    RTS
SS_SYNC2:
    DEX
    BNE SS_SYNC_L
    CLC
    RTS
SS_EOD:
    LDA LOOP_OFF_L
    ORA LOOP_OFF_M
    ORA LOOP_OFF_H
    BEQ SS_EOD_DONE
    LDA LOOP_EN
    BEQ SS_EOD_DONE
    JSR DO_LOOP_SEEK
    SEC
    RTS
SS_EOD_DONE:
    LDA #$01
    STA DONE_FLAG
    SEC
    RTS

; DO_SEEK_FWD — fast-forward 5 s (300 frames @ 60 Hz).  Decodes frames
; through SEEK_STEP (SHADOW-only, no publish), then restores the PSG from
; SHADOW.  On EOD+loop the file cursor ends up at loopOffset; on EOD with no
; loop DONE_FLAG=1 (MAIN -> SONG_DONE).  Clock jumps +5 s.
DO_SEEK_FWD:
    LDA IRQ_ACTIVE
    BEQ SF_NOWAIT
SF_WAIT:
    LDA FB_READY
    BNE SF_WAIT
SF_NOWAIT:
    LDA #<300
    STA SEEK_CNT_L
    LDA #>300
    STA SEEK_CNT_H
SF_LOOP:
    JSR SEEK_STEP
    BCS SF_DONE
    INC FRM0
    BNE SF_F1
    INC FRM1
    BNE SF_F1
    INC FRM2
SF_F1:
    LDA SEEK_CNT_L
    SEC
    SBC #$01
    STA SEEK_CNT_L
    LDA SEEK_CNT_H
    SBC #$00
    STA SEEK_CNT_H
    LDA SEEK_CNT_L
    ORA SEEK_CNT_H
    BNE SF_LOOP
SF_DONE:
    ; clock += 5 s
    CLC
    LDA CLK_SEC
    ADC #5
    STA SEEK_TMP
    CMP #60
    BCC SF_CLK_OK
    SEC
    SBC #60
    INC CLK_MIN
    STA SEEK_TMP
SF_CLK_OK:
    LDA SEEK_TMP
    STA CLK_SEC
    SEI
    JSR RESTORE_ALL
    CLI
    JMP MAIN

; DO_SEEK_BWD — rewind 5 s (up to 300 frames, clamped at song start).
; SET_MARK(0) the file cursor, clear SHADOW, fast-scan TARG frames, clock
; -= 5 s (with borrow).  FRM0/1/2 restart from 0 and end at TARG.
DO_SEEK_BWD:
    LDA IRQ_ACTIVE
    BEQ SB_NOWAIT
SB_WAIT:
    LDA FB_READY
    BNE SB_WAIT
SB_NOWAIT:
    SEC
    LDA FRM0
    SBC #<300
    STA TARG_L
    LDA FRM1
    SBC #>300
    STA TARG_H
    BCS SB_TARG_OK
    LDA #$00
    STA TARG_L
    STA TARG_H
SB_TARG_OK:
    LDA #$00
    STA SETMARK_PARAMS+2
    STA SETMARK_PARAMS+3
    STA SETMARK_PARAMS+4
    JSR SEEK_TO
    BCS SB_FAIL
    JSR CLEAR_SHADOW
    LDA #$00
    STA FRM0
    STA FRM1
    STA FRM2
    LDA TARG_L
    ORA TARG_H
    BNE SB_SCAN
    ; TARG = 0: song restart — silence + zero the clock
    JSR SILENCE_ALL
    LDA #$00
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN
SB_SCAN:
SB_SCAN_LOOP:
    JSR SEEK_STEP
    BCS SB_DONE
    INC FRM0
    BNE SB_F1
    INC FRM1
    BNE SB_F1
    INC FRM2
SB_F1:
    LDA TARG_L
    SEC
    SBC #$01
    STA TARG_L
    LDA TARG_H
    SBC #$00
    STA TARG_H
    LDA TARG_L
    ORA TARG_H
    BNE SB_SCAN_LOOP
SB_DONE:
    ; clock -= 5 s (borrow from minutes; wrap at zero ignored)
    SEC
    LDA CLK_SEC
    SBC #5
    STA CLK_SEC
    BCS SB_CLK_OK
    LDA CLK_SEC
    CLC
    ADC #60
    STA CLK_SEC
    LDA CLK_MIN
    BEQ SB_CLK_OK
    DEC CLK_MIN
SB_CLK_OK:
    SEI
    JSR RESTORE_ALL
    CLI
    JMP MAIN
SB_FAIL:
    SEI
    JSR RESTORE_ALL
    CLI
    JMP MAIN

; DO_RESTART — restart the current song from frame 0: rewind the file
; cursor, reset engine state + clock, re-arm the loop, unpause.
DO_RESTART:
    LDA IRQ_ACTIVE
    BEQ RS_NOWAIT
RS_WAIT:
    LDA FB_READY
    BNE RS_WAIT
RS_NOWAIT:
    LDA #$00
    STA SETMARK_PARAMS+2
    STA SETMARK_PARAMS+3
    STA SETMARK_PARAMS+4
    JSR SEEK_TO
    BCS RS_EXIT
    JSR CLEAR_SHADOW
    LDA #$00
    STA FRM0
    STA FRM1
    STA FRM2
    STA CLK_FRM
    STA CLK_SEC
    STA CLK_MIN
    STA FRAC
    STA HOLD_LEFT
    STA DONE_FLAG
    STA ERR
    STA STREAM_END
    STA EOF_FLAG
    STA PAUSE
    LDA #$01
    STA LOOP_EN
RS_EXIT:
    SEI
    JSR RESTORE_ALL
    CLI
    JMP MAIN

; DO_LOOP — toggle in-song loop (EOD follows it when LOOP_EN=1).
DO_LOOP:
    LDA LOOP_EN
    EOR #$01
    STA LOOP_EN
    JMP MAIN

; --------------------------------------------------------------------------
; PCM support (full ZSM: PSG + FM + PCM). PCM samples are staged in
; PCM_BUFFER (bulk-read at trigger) and fed to the VERA FIFO ($Cn1D) from
; the main loop's idle PUB_WAIT. Uses a 2nd refnum (PCM_REF) so the main
; ZSM stream cursor is untouched.
; --------------------------------------------------------------------------

; READ_PCM_SETUP — called after READ_HEADER. PCM_TBL_L/M/H = pcmTableOffset
; (header bytes 6-8). If 0, no PCM. Else open a 2nd refnum and read the
; instrument table (magic + instMax); compute DATA_BASE for later triggers.
READ_PCM_SETUP:
    LDA PCM_TBL_L
    ORA PCM_TBL_M
    ORA PCM_TBL_H
    BNE RPS_HAVE
    JMP RPS_RTS
RPS_HAVE:
    JSR OPEN_PCM
    LDA ERR
    BEQ RPS_OK
    JMP RPS_RTS
RPS_OK:
    ; SET_MARK(pcmTableOffset) on PCM_REF
    LDA PCM_REF
    STA SETMARK_PARAMS+1
    LDA PCM_TBL_L
    STA SETMARK_PARAMS+2
    LDA PCM_TBL_M
    STA SETMARK_PARAMS+3
    LDA PCM_TBL_H
    STA SETMARK_PARAMS+4
    JSR MLI
    !byte $CE
    !word SETMARK_PARAMS
    BCC RPS_MARK
    STA ERRCODE
    LDA #$42
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
    RTS
RPS_MARK:
    ; READ 4 bytes (magic + instMax) into PCM_TMP
    LDA PCM_REF
    STA READ_PARAMS+1
    LDA #<PCM_TMP
    STA READ_PARAMS+2
    LDA #>PCM_TMP
    STA READ_PARAMS+3
    LDA #$04
    STA READ_PARAMS+4
    LDA #$00
    STA READ_PARAMS+5
    JSR MLI
    !byte $CA
    !word READ_PARAMS
    BCC RPS_READ
    CMP #$4C
    BEQ RPS_EOF
    STA ERRCODE
    LDA #$43
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
    RTS
RPS_EOF:
    LDA #$00
    STA PCM_INST_MAX
    JMP RPS_CALC
RPS_READ:
    ; verify "PCM" magic
    LDA PCM_TMP
    CMP #'P'
    BNE RPS_NOMAGIC
    LDA PCM_TMP+1
    CMP #'C'
    BNE RPS_NOMAGIC
    LDA PCM_TMP+2
    CMP #'M'
    BNE RPS_NOMAGIC
    LDA PCM_TMP+3
    STA PCM_INST_MAX
RPS_NOMAGIC:
RPS_CALC:
    ; DATA_BASE = PCM_TBL + 4 + (instMax+1)*16
    ; = PCM_TBL + 20 + (instMax<<4)
    LDA PCM_TBL_L
    CLC
    ADC #$14
    STA PCM_DATA_BASE_L
    LDA PCM_TBL_M
    ADC #$00
    STA PCM_DATA_BASE_M
    LDA PCM_TBL_H
    ADC #$00
    STA PCM_DATA_BASE_H
    LDA PCM_INST_MAX
    ASL A
    ASL A
    ASL A
    ASL A                ; instMax * 16
    STA PCM_TMP
    LDA #$00
    STA PCM_TMP+1
    LDA PCM_TMP
    CLC
    ADC PCM_DATA_BASE_L
    STA PCM_DATA_BASE_L
    LDA PCM_TMP+1
    ADC PCM_DATA_BASE_M
    STA PCM_DATA_BASE_M
    LDA #$00
    ADC PCM_DATA_BASE_H
    STA PCM_DATA_BASE_H
RPS_RTS:
    RTS

; OPEN_PCM — open the same ZSM file a 2nd time (PCM_REF). Reuses PATH_BUF
; (already built by OPEN_STREAM); uses PCM_FILE_BUF as its FCB.
OPEN_PCM:
    LDA #$00
    STA ERR
    LDA #$03
    STA OPEN_PARAMS
    LDA #<PCM_FILE_BUF
    STA OPEN_PARAMS+3
    LDA #>PCM_FILE_BUF
    STA OPEN_PARAMS+4
    JSR MLI
    !byte $C8
    !word OPEN_PARAMS
    BCC OPEN_PCM_OK
    STA ERRCODE
    LDA #$44
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
    RTS
OPEN_PCM_OK:
    LDA OPEN_PARAMS+5
    STA PCM_REF
    RTS

; PCM_APPLY_EVENT — apply one [sub,val] PCM sub-event decoded from EXTCMD.
PCM_APPLY_EVENT:
    LDA PCM_SUB
    BEQ PCM_EV_CTRL
    CMP #$01
    BEQ PCM_EV_RATE
    JMP PCM_EV_TRIGGER
PCM_EV_CTRL:
    ; volume = val & 0x0F; bit7 = FIFO flush
    LDA PCM_VAL
    AND #$0F
    STA PCM_VOLUME
    JSR PCM_WRITE_CTRL
    LDA PCM_VAL
    AND #$80
    BEQ PCM_EV_RTS
    LDA PCM_CTRL
    ORA #$80
    STA VERA_AUDIO_CTRL
PCM_EV_RTS:
    RTS
PCM_EV_RATE:
    LDA PCM_VAL
    STA PCM_RATE
    ; effRate = (rate>128)?(256-rate):rate
    CMP #$80
    BCC PCM_RATE_LE128
    LDA #$00
    SEC
    SBC PCM_RATE
    STA PCM_EFFRATE
    JMP PCM_RATE_BUDGET
PCM_RATE_LE128:
    LDA PCM_RATE
    STA PCM_EFFRATE
PCM_RATE_BUDGET:
    ; budget = effRate*7 + 128  (16-bit)
    LDA PCM_EFFRATE
    STA PCM_TMP
    LDA #$00
    STA PCM_TMP+1
    ; <<3 (effRate*8)
    ASL PCM_TMP
    ROL PCM_TMP+1
    ASL PCM_TMP
    ROL PCM_TMP+1
    ASL PCM_TMP
    ROL PCM_TMP+1
    ; - effRate (effRate*7)
    LDA PCM_TMP
    SEC
    SBC PCM_EFFRATE
    STA PCM_TMP
    LDA PCM_TMP+1
    SBC #$00
    STA PCM_TMP+1
    ; + 128
    LDA PCM_TMP
    CLC
    ADC #$80
    STA PCM_BUDGET_L
    LDA PCM_TMP+1
    ADC #$00
    STA PCM_BUDGET_H
    ; write rate register
    LDA PCM_RATE
    STA VERA_AUDIO_RATE
    RTS
PCM_EV_TRIGGER:
    LDA PCM_VAL
    JSR PCM_TRIGGER
    RTS

; PCM_WRITE_CTRL — ctrl = format<<4 | volume -> $Cn1B
PCM_WRITE_CTRL:
    LDA PCM_FORMAT
    ASL A
    ASL A
    ASL A
    ASL A
    ORA PCM_VOLUME
    STA PCM_CTRL
    STA VERA_AUDIO_CTRL
    RTS

; PCM_TRIGGER — A = instrument idx. Read its 16-byte entry from the table,
; bulk-read its sample data into PCM_BUFFER (if not loaded), set up state.
PCM_TRIGGER:
    STA PCM_INST
    ; entryAddr = PCM_TBL + 4 + (idx<<4)
    LDA PCM_TBL_L
    CLC
    ADC #$04
    STA SETMARK_PARAMS+2
    LDA PCM_TBL_M
    ADC #$00
    STA SETMARK_PARAMS+3
    LDA PCM_TBL_H
    ADC #$00
    STA SETMARK_PARAMS+4
    LDA PCM_INST
    ASL A
    ASL A
    ASL A
    ASL A
    STA PCM_TMP
    LDA #$00
    STA PCM_TMP+1
    LDA PCM_TMP
    CLC
    ADC SETMARK_PARAMS+2
    STA SETMARK_PARAMS+2
    LDA PCM_TMP+1
    ADC SETMARK_PARAMS+3
    STA SETMARK_PARAMS+3
    LDA #$00
    ADC SETMARK_PARAMS+4
    STA SETMARK_PARAMS+4
    LDA PCM_REF
    STA SETMARK_PARAMS+1
    JSR MLI
    !byte $CE
    !word SETMARK_PARAMS
    BCC PT_MARK
    STA ERRCODE
    LDA #$45
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
    RTS
PT_MARK:
    ; READ 16 bytes into PCM_ENTRY
    LDA PCM_REF
    STA READ_PARAMS+1
    LDA #<PCM_ENTRY
    STA READ_PARAMS+2
    LDA #>PCM_ENTRY
    STA READ_PARAMS+3
    LDA #$10
    STA READ_PARAMS+4
    LDA #$00
    STA READ_PARAMS+5
    JSR MLI
    !byte $CA
    !word READ_PARAMS
    BCC PT_READ
    CMP #$4C
    BEQ PT_EOF
    STA ERRCODE
    LDA #$46
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
    RTS
PT_EOF:
    LDA #$00
    STA PCM_ACTIVE
    RTS
PT_READ:
    ; geometry = PCM_ENTRY+1 (bits 5:4)
    LDA PCM_ENTRY+1
    AND #$30
    LSR A
    LSR A
    LSR A
    LSR A
    STA PCM_FORMAT
    ; off = PCM_ENTRY+2..4
    LDA PCM_ENTRY+2
    STA PCM_OFF_L
    LDA PCM_ENTRY+3
    STA PCM_OFF_M
    LDA PCM_ENTRY+4
    STA PCM_OFF_H
    ; length = PCM_ENTRY+5..7
    LDA PCM_ENTRY+5
    STA PCM_LEN_L
    LDA PCM_ENTRY+6
    STA PCM_LEN_M
    LDA PCM_ENTRY+7
    STA PCM_LEN_H
    ; looped = PCM_ENTRY+8 bit7
    LDA PCM_ENTRY+8
    AND #$80
    BEQ PT_NOLOOP
    LDA #$01
    STA PCM_LOOPED
    JMP PT_LOOPPT
PT_NOLOOP:
    LDA #$00
    STA PCM_LOOPED
PT_LOOPPT:
    ; loopPoint = PCM_ENTRY+9..11
    LDA PCM_ENTRY+9
    STA PCM_LOOP_L
    LDA PCM_ENTRY+10
    STA PCM_LOOP_M
    LDA PCM_ENTRY+11
    STA PCM_LOOP_H
    ; fileOffset = DATA_BASE + off
    LDA PCM_DATA_BASE_L
    CLC
    ADC PCM_OFF_L
    STA PCM_FILE_OFF_L
    LDA PCM_DATA_BASE_M
    ADC PCM_OFF_M
    STA PCM_FILE_OFF_M
    LDA PCM_DATA_BASE_H
    ADC PCM_OFF_H
    STA PCM_FILE_OFF_H
    ; load data into PCM_BUFFER if not loaded
    LDA PCM_LOADED
    CMP PCM_INST
    BEQ PT_LOADED
    ; SET_MARK(fileOffset) on PCM_REF
    LDA PCM_REF
    STA SETMARK_PARAMS+1
    LDA PCM_FILE_OFF_L
    STA SETMARK_PARAMS+2
    LDA PCM_FILE_OFF_M
    STA SETMARK_PARAMS+3
    LDA PCM_FILE_OFF_H
    STA SETMARK_PARAMS+4
    JSR MLI
    !byte $CE
    !word SETMARK_PARAMS
    BCC PT_MARK2
    STA ERRCODE
    LDA #$47
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
    RTS
PT_MARK2:
    JSR PCM_READ_DATA
    LDA ERR
    BNE PT_RTS
    LDA PCM_INST
    STA PCM_LOADED
PT_LOADED:
    LDA #$00
    STA PCM_POS_L
    STA PCM_POS_M
    STA PCM_POS_H
    LDA #$01
    STA PCM_ACTIVE
    JSR PCM_WRITE_CTRL
    LDA PCM_RATE
    STA VERA_AUDIO_RATE
PT_RTS:
    RTS

; PCM_READ_DATA — bulk-read PCM_LEN bytes (from PCM_REF, current position)
; into PCM_BUFFER, capped at PCM_BUFFER_SIZE. 24-bit count.
PCM_READ_DATA:
    LDA #<PCM_BUFFER
    STA PCM_DST_L
    LDA #>PCM_BUFFER
    STA PCM_DST_H
    LDA PCM_LEN_L
    STA PCM_COUNT_L
    LDA PCM_LEN_M
    STA PCM_COUNT_M
    LDA PCM_LEN_H
    STA PCM_COUNT_H
    ; cap count at PCM_BUFFER_SIZE ($1C00 = 7168)
    LDA PCM_COUNT_H
    CMP #$1C
    BCC PRD_LOOP
    LDA #$00
    STA PCM_COUNT_L
    LDA #$1C
    STA PCM_COUNT_M
    LDA #$00
    STA PCM_COUNT_H
PRD_LOOP:
    LDA PCM_COUNT_L
    ORA PCM_COUNT_M
    ORA PCM_COUNT_H
    BNE PRD_CONT
    JMP PRD_DONE
PRD_CONT:
    ; chunk = min(512, count)
    LDA PCM_COUNT_H
    BNE PRD_512
    LDA PCM_COUNT_M
    CMP #$02
    BCS PRD_512
    LDA PCM_COUNT_L
    STA PCM_CHUNK_L
    LDA #$00
    STA PCM_CHUNK_H
    JMP PRD_READY
PRD_512:
    LDA #$00
    STA PCM_CHUNK_L
    LDA #$02
    STA PCM_CHUNK_H
PRD_READY:
    LDA PCM_REF
    STA READ_PARAMS+1
    LDA PCM_DST_L
    STA READ_PARAMS+2
    LDA PCM_DST_H
    STA READ_PARAMS+3
    LDA PCM_CHUNK_L
    STA READ_PARAMS+4
    LDA PCM_CHUNK_H
    STA READ_PARAMS+5
    JSR MLI
    !byte $CA
    !word READ_PARAMS
    BCC PRD_READ2
    CMP #$4C
    BEQ PRD_EOF
    STA ERRCODE
    LDA #$48
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
    RTS
PRD_EOF:
    LDA #$00
    STA PCM_ACTIVE
    JMP PRD_DONE
PRD_READ2:
    ; dest += bytesRead
    LDA READ_PARAMS+6
    CLC
    ADC PCM_DST_L
    STA PCM_DST_L
    LDA READ_PARAMS+7
    ADC PCM_DST_H
    STA PCM_DST_H
    ; count -= bytesRead
    LDA READ_PARAMS+6
    STA PCM_TMP
    LDA READ_PARAMS+7
    STA PCM_TMP+1
    LDA PCM_COUNT_L
    SEC
    SBC PCM_TMP
    STA PCM_COUNT_L
    LDA PCM_COUNT_M
    SBC PCM_TMP+1
    STA PCM_COUNT_M
    LDA PCM_COUNT_H
    SBC #$00
    STA PCM_COUNT_H
    JMP PRD_LOOP
PRD_DONE:
    RTS

; FEED_PCM — push PCM_BUFFER[pcmPos] to the VERA FIFO. Called from PUB_WAIT
; (main loop idle). Bounded by per-frame budget + FIFO-full.
FEED_PCM:
    LDA PCM_ACTIVE
    BEQ FP_RTS
    LDA PCM_FED_H
    CMP PCM_BUDGET_H
    BCS FP_RTS
    BNE FP_DO
    LDA PCM_FED_L
    CMP PCM_BUDGET_L
    BCS FP_RTS
FP_DO:
    ; FIFO full?
    LDA VERA_AUDIO_CTRL
    AND #$80
    BNE FP_RTS
    ; push PCM_BUFFER[pcmPos]
    JSR FP_PUSH_ONE
FP_RTS:
    RTS

; FP_PUSH_ONE — push one byte from PCM_BUFFER[pcmPos], advance pcmPos,
; handle loop/end. Clobbers A/Y.
FP_PUSH_ONE:
    ; pcmPos >= PCM_LEN?
    LDA PCM_POS_H
    CMP PCM_LEN_H
    BCC FP_OK
    BNE FP_END
    LDA PCM_POS_M
    CMP PCM_LEN_M
    BCC FP_OK
    BNE FP_END
    LDA PCM_POS_L
    CMP PCM_LEN_L
    BCS FP_END
FP_OK:
    ; byte = PCM_BUFFER[pcmPos]
    LDA PCM_POS_L
    CLC
    ADC #<PCM_BUFFER
    STA PCM_FP_ADDR_L
    LDA PCM_POS_M
    ADC #>PCM_BUFFER
    STA PCM_FP_ADDR_H
    LDY #$00
    LDA (PCM_FP_ADDR_L),Y
    STA VERA_AUDIO_DATA
    ; pcmPos++
    INC PCM_POS_L
    BNE FP_DONE
    INC PCM_POS_M
    BNE FP_DONE
    INC PCM_POS_H
FP_DONE:
    ; PCM_FED++
    INC PCM_FED_L
    BNE FP_DONE2
    INC PCM_FED_H
FP_DONE2:
    RTS
FP_END:
    ; end of sample: loop or stop
    LDA PCM_LOOPED
    BEQ FP_STOP
    ; pcmPos = loopPoint
    LDA PCM_LOOP_L
    STA PCM_POS_L
    LDA PCM_LOOP_M
    STA PCM_POS_M
    LDA PCM_LOOP_H
    STA PCM_POS_H
    RTS
FP_STOP:
    LDA #$00
    STA PCM_ACTIVE
    RTS

; PCM_KEY_OFF — silence PCM on song end/exit.
PCM_KEY_OFF:
    LDA #$00
    STA PCM_ACTIVE
    LDA VERA_AUDIO_CTRL
    ORA #$80
    STA VERA_AUDIO_CTRL
    RTS

; PCM_CLOSE — close the PCM refnum (2nd open of the same song file).
PCM_CLOSE:
    LDA PCM_REF
    BEQ PCM_CLOSE_DONE
    STA CLOSE_PARAMS+1
    JSR MLI
    !byte $CC              ; CLOSE
    !word CLOSE_PARAMS
    LDA #$00
    STA PCM_REF
PCM_CLOSE_DONE:
    RTS

; --------------------------------------------------------------------------
; Song end / exit paths
; --------------------------------------------------------------------------
SONG_DONE:
    LDA #$17
    STA DEBUG_MARKER
    JSR PCM_KEY_OFF
    JSR PCM_CLOSE
    JSR FM_KEY_OFF
    JSR SILENCE_ALL
    JSR CLOSE_STREAM
    JSR IRQ_OFF
    LDA #$00
    STA IRQ_ACTIVE
    JMP MENU

SONG_EXIT:
    JSR PCM_KEY_OFF
    JSR PCM_CLOSE
    JSR FM_KEY_OFF
    JSR SILENCE_ALL
    JSR CLOSE_STREAM
    JSR IRQ_OFF
    LDA #$00
    STA IRQ_ACTIVE
    JMP MENU

DO_EXIT:
    LDA #$18
    STA DEBUG_MARKER
    JSR IRQ_OFF
    JSR SILENCE_ALL
    JSR FM_KEY_OFF
    JSR PCM_KEY_OFF
    JSR PCM_CLOSE
    JSR CLOSE_STREAM
    RTS                   ; back to BASIC.SYSTEM (BRUN entry)

DO_MUTE:
    SEI
    LDA MUTE
    BNE DO_UNMUTE
    LDA #$01
    STA MUTE
    JSR SILENCE_ALL
    CLI
    JMP MAIN
DO_UNMUTE:
    JSR RESTORE_ALL
    LDA #$00
    STA MUTE
    CLI
    JMP MAIN

DO_PAUSE:
    LDA PAUSE
    BNE DO_RESUME
    LDA #$01
    STA PAUSE
    JMP MAIN
DO_RESUME:
    LDA #$00
    STA PAUSE
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

DISK_FAIL:
    LDA #$16
    STA DEBUG_MARKER
    JSR IRQ_OFF_SAFE
    JSR SILENCE_ALL
    JSR FM_KEY_OFF
    JSR PCM_KEY_OFF
    JSR PCM_CLOSE
    JSR CLOSE_STREAM
    ; Print "DISK ERR" at $06D0
    LDY #$00
DF_ERR_LOOP:
    LDA ERRMSG,Y
    BEQ DF_ERR_LOOP_DONE
    ORA #$80
    STA $06D0,Y
    INY
    BNE DF_ERR_LOOP
DF_ERR_LOOP_DONE:
    LDA #$A0
    STA $06F0
    LDA #$A4              ; '$'
    STA $06F1
    LDX #$00
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
    ADC #$36              ; C=1 from CMP. NO CLC.
    ORA #$80
    STA $06F2,X
    INX
    RTS
NIBD_ERR:
    ORA #$B0
    STA $06F2,X
    INX
    RTS

; --------------------------------------------------------------------------
; IRQ plumbing (same pattern as psgstream.asm, + VERA_CTRL save)
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
    LDA VERA_CTRL
    STA SAV_CTRL
    JSR TICK
    LDA SAV_L
    STA VERA_ADDR_L
    LDA SAV_M
    STA VERA_ADDR_M
    LDA SAV_H
    STA VERA_ADDR_H
    LDA SAV_CTRL
    STA VERA_CTRL
IRQ_DONE:
    PLA
    TAY
    PLA
    TAX
    PLA
    RTI

; --------------------------------------------------------------------------
; TICK — one VSYNC: normalize tick rate, consume one published frame
; --------------------------------------------------------------------------
TICK:
    LDA MUTE
    BEQ TICK1
    JMP TICK_DONE
TICK1:
    LDA PAUSE
    BEQ TICK2
    JMP TICK_DONE
TICK2:
    ; tick-rate accumulator: FRAC += TICKRATE; if >= 60 consume one frame
    LDA FRAC
    CLC
    ADC TICKRATE
    STA FRAC
    CMP #60
    BCS TICK3
    JMP TICK_NOFRAME
TICK3:
    SEC
    SBC #60
    STA FRAC
    LDA FB_READY
    BNE TICK4
    JMP TICK_NOFRAME
TICK4:
    LDY #$00
    LDA (FB_ACT_L),Y
    CMP #$FF
    BEQ TICK_HOLD
    STA TCNT1
    BEQ TICK_YM
TICK_PSG:
    INY
    LDA (FB_ACT_L),Y       ; reg
    TAX
    INY
    LDA (FB_ACT_L),Y       ; val
    STA SHADOW,X
    TXA
    AND #$03
    CMP #$02
    BNE TICK_NOSCALE
    LDA SHADOW,X
    JSR SCALE_PSG_REG
    JMP TICK_SEND
TICK_NOSCALE:
    LDA SHADOW,X
TICK_SEND:
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
    DEC TCNT1
    BNE TICK_PSG
TICK_YM:
    INY
    LDA (FB_ACT_L),Y       ; ymCnt
    STA TCNT2
    BEQ TICK_APPLY_DONE
TICK_YML:
    INY
    LDA (FB_ACT_L),Y       ; reg
    STA YM_REG
    INY
    LDA (FB_ACT_L),Y       ; val
    STA YM_DATA
    DEC TCNT2
    BNE TICK_YML
TICK_APPLY_DONE:
    LDA #$00
    STA FB_READY
    JMP TICK_BUMP
TICK_HOLD:
    LDA #$00
    STA FB_READY
    JMP TICK_BUMP
TICK_NOFRAME:
    RTS
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
    BCS TICK5
    JMP TICK_DONE
TICK5:
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

; --------------------------------------------------------------------------
; Feeder: A = next stream byte. Refills the $4000 block at boundary.
; Clobbers A only. Sets STREAM_END on EOF/truncation.
; --------------------------------------------------------------------------
GETB:
    LDA STREAM_H
    CMP BUF_END_H
    BCC GETB_READY
    BNE GETB_EXHAUSTED
    LDA STREAM_L
    CMP BUF_END_L
    BCC GETB_READY
GETB_EXHAUSTED:
    LDA EOF_FLAG
    BNE GETB_TRUNCATED
    JSR REFILL
    LDA ERR
    BEQ GETB_READY
GETB_TRUNCATED:
    LDA #$01
    STA STREAM_END
    LDA #$00
    RTS
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
; ProDOS file I/O (same as psgstream.asm, name pointer instead of fixed file)
; --------------------------------------------------------------------------
OPEN_STREAM:
    JSR BUILD_FILE_PATH
    BCC OPEN_PATH_OK
    LDA #$40
    STA ERRCODE
    LDA #$49
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
    RTS
OPEN_PATH_OK:
    LDA #$00
    STA ERR
    LDA #$03
    STA OPEN_PARAMS
    JSR MLI
    !byte $C8
    !word OPEN_PARAMS
    BCC OPEN_STREAM_OK
    STA ERRCODE
    LDA #$4A
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
    RTS
OPEN_STREAM_OK:
    LDA OPEN_PARAMS+5
    STA REF_NUM
    LDA #$00
    STA SHORT_READ
    STA EOF_FLAG
    RTS

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
    LDX PATH_BUF
    LDY #$00
BFP_NAME_LOOP:
    LDA (NAME_PTR_L),Y
    BEQ BFP_DONE
    INX
    CPX #$40
    BCS BFP_FAIL
    STA PATH_BUF,X
    INY
    CPY #15
    BCS BFP_DONE
    BNE BFP_NAME_LOOP
BFP_DONE:
    TXA
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
    !byte $CC
    !word CLOSE_PARAMS
    LDA #$00
    STA REF_NUM
CLOSE_STREAM_DONE:
    RTS

; --------------------------------------------------------------------------
; REFILL — read up to 512 B. EOF ($4C) or empty read is tolerated and sets
; EOF_FLAG + STREAM_END via GETB. (pcmstream EOF-tolerant version)
; --------------------------------------------------------------------------
REFILL:
    PHP
    PHA
    TXA
    PHA
    TYA
    PHA
    ; READ_PARAMS is shared with PCM bulk reads; make REFILL self-contained
    ; so a PCM read clobbering +2..+5 can't corrupt the main stream refill.
    LDA REF_NUM
    STA READ_PARAMS+1
    LDA #<BUF_LO
    STA READ_PARAMS+2
    LDA #>BUF_LO
    STA READ_PARAMS+3
    LDA #$00
    STA READ_PARAMS+4
    LDA #$02
    STA READ_PARAMS+5
    JSR MLI
    !byte $CA
    !word READ_PARAMS
    BCC REFILL_SUCCESS
    CMP #$4C
    BEQ REFILL_EOF
    STA ERRCODE
    LDA #$4B
    STA ERRSRC
    LDA ERRCODE
    LDA #$01
    STA ERR
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
    BEQ REFILL_FULL_OK
    JMP REFILL_MARK_SHORT
REFILL_FULL_OK:
    ; a full 512-byte read clears any stale EOF flag from a previous short
    ; read (otherwise EOF_FLAG=1 survives a loop-seek and the next exhaustion
    ; is misread as EOF right after the 2nd loop).
    LDA #$00
    STA EOF_FLAG
    JMP REFILL_SET_PTR
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
; PSG helpers (same as psgstream.asm)
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

FM_KEY_OFF:
    LDA #$08
    STA YM_REG
    LDA #$00
    STA YM_DATA
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
    LDA #$08
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
    AND #$C0
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

; --------------------------------------------------------------------------
; CLEAR_SHADOW — zero the 64-byte shadow register set
; --------------------------------------------------------------------------
CLEAR_SHADOW:
    LDA #$00
    LDX #$00
CS_L:
    STA SHADOW,X
    INX
    CPX #$40
    BNE CS_L
    RTS

; --------------------------------------------------------------------------
; CLEAR_SCREEN — blank the 40-col text page ($0400-$07FF)
; --------------------------------------------------------------------------
CLEAR_SCREEN:
    LDA #$A0
    LDX #$00
CLR_L:
    STA $0400,X
    STA $0500,X
    STA $0600,X
    STA $0700,X
    INX
    BNE CLR_L
    RTS

; --------------------------------------------------------------------------
; DRAW_MENU — banner row 0, 10 song rows (title), controls row
; --------------------------------------------------------------------------
DRAW_MENU:
    LDY #$00
DM_BANNER:
    LDA MENU_TITLE,Y
    BEQ DM_SONGS
    ORA #$80
    STA $0400,Y
    INY
    CPY #40
    BNE DM_BANNER
DM_SONGS:
    LDX #$00
DM_SONG_LOOP:
    ; row addr from ROW_TBL (2-byte entries indexed by song*2)
    TXA
    ASL A
    TAY
    LDA ROW_TBL,Y
    STA DM_ADDR_L
    INY
    LDA ROW_TBL,Y
    STA DM_ADDR_H
    ; number: '1'+X, '0' for index 9, 'S' for index 10
    TXA
    CMP #10
    BCS DM_NUM_LETTER
    CLC
    ADC #$31
    CMP #$3A
    BCC DM_NUM_OK
    LDA #$30
    JMP DM_NUM_OK
DM_NUM_LETTER:
    LDA #$53              ; 'S' (Shovel Knight)
DM_NUM_OK:
    ORA #$80
    LDY #$00
    STA (DM_ADDR_L),Y
    INY
    LDA #$AE              ; '.'
    ORA #$80
    STA (DM_ADDR_L),Y
    INY
    LDA #$A0
    STA (DM_ADDR_L),Y
    INY
    ; title at DM_ADDR+3
    LDA DM_ADDR_L
    CLC
    ADC #$03
    STA DM_ADDR_L
    BCC DM_TADDR
    INC DM_ADDR_H
DM_TADDR:
    ; title ptr = SONG_TITLES + X*32
    TXA
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    CLC
    ADC #<SONG_TITLES
    STA DM_TITLE_PTR_L
    LDA #>SONG_TITLES
    ADC #$00
    STA DM_TITLE_PTR_H
    LDY #$00
DM_TITLE_LOOP:
    LDA (DM_TITLE_PTR_L),Y
    BEQ DM_TITLE_DONE
    ORA #$80
    STA (DM_ADDR_L),Y
    INY
    CPY #32
    BNE DM_TITLE_LOOP
DM_TITLE_DONE:
    INX
    CPX #11
    BNE DM_SONG_LOOP
    ; controls line
    LDY #$00
DM_CTRL:
    LDA MENU_CTRL,Y
    BEQ DM_CTRL2
    ORA #$80
    STA $0638,Y
    INY
    CPY #40
    BNE DM_CTRL
    ; second control line at $0660 (row 13)
DM_CTRL2:
    LDY #$00
DM_CTRL2_L:
    LDA MENU_CTRL2,Y
    BEQ DM_DONE
    ORA #$80
    STA $0660,Y
    INY
    CPY #40
    BNE DM_CTRL2_L
DM_DONE:
    RTS

ROW_TBL:
    !word $0480,$04A8,$04D0,$04F8,$0520,$0548,$0570,$0598,$05C0,$05E8,$0610

; --------------------------------------------------------------------------
; SHOW_STATUS — row 23 "T: mm:ss.s [16ch meter] V:xx"
; --------------------------------------------------------------------------
SHOW_STATUS:
    LDA #$00
    STA $C002
    STA $C004
    STA $C000
    STA $C054
    STA $C00C
    STA $C051
    STA $C052
    STA $C056
    SEI
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
    LDA #$A0
    STA $07D2
    ; minutes
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
    LDA #$BA
    STA $07D5
    ; seconds
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
    ; tenths
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
    ; 16-ch meter
    LDA #$A0
    STA $07DA
    LDA #$DB              ; '['
    STA $07DB
    LDY #$02
    LDX #$00
METER_LOOP:
    LDA SHADOW,Y
    AND #$3F
    BEQ METER_DOT
    CMP #15
    BCC METER_DASH
    CMP #35
    BCC METER_EQ
    CMP #50
    BCC METER_HASH
    LDA #$DE              ; '^'
    !byte $2C
METER_HASH:
    LDA #$A3
    !byte $2C
METER_EQ:
    LDA #$BD
    !byte $2C
METER_DASH:
    LDA #$AD
    !byte $2C
METER_DOT:
    LDA #$AE
METER_PUT:
    STA $07DC,X
    INX
    TYA
    CLC
    ADC #$04
    TAY
    CPX #$10
    BNE METER_LOOP
    LDA #$DD              ; ']'
    STA $07EC
    ; V:xx
    LDA #$A0
    STA $07ED
    LDA #$D6              ; 'V'
    STA $07EE
    LDA #$BA              ; ':'
    STA $07EF
    LDA MASTER_VOL
    LDX #$B0
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
    STA $07F0
    PLA
    ORA #$B0
    STA $07F1
    ; P indicator
    LDA #$A0
    STA $07F2
    STA $07F3
    LDA PAUSE
    BEQ SS_UNPAUSED
    LDA #$D0              ; 'P'
    STA $07F3
SS_UNPAUSED:
    LDA #$A0
    STA $07F4
    STA $07F5
    STA $07F6
    STA $07F7
    RTS

; --------------------------------------------------------------------------
; Strings
; --------------------------------------------------------------------------
MENU_TITLE:
    ASC "ZSM JUKEBOX R1 FOR APPLE II          "
    !byte 0
MENU_CTRL:
    ASC "ESC/Q=EXIT  1-9,0=S  P=PAUSE  M=MUTE"
    !byte 0
MENU_CTRL2:
    ASC "+/-:VOL  R=RESTART  L=LOOP  [/]:SEEK"
    !byte 0
ERRMSG:
    ASC "DISK ERR - STREAM BLOCK UNREADABLE"
    !byte 0

; --------------------------------------------------------------------------
; Song table: 10 songs, 15-byte ProDOS name + 32-char title = 47 bytes each
; --------------------------------------------------------------------------
SONG_NAMES:
CANYON_NAME:
    ASC "CANYON.ZSM"
    !byte 0
TITLE_NAME:
    ASC "TITLE.ZSM"
    !byte 0
HIGHSCORE_NAME:
    ASC "HIGHSCORE.ZSM"
    !byte 0
GAMEOVER_NAME:
    ASC "GAMEOVER.ZSM"
    !byte 0
KILLED_NAME:
    ASC "KILLED.ZSM"
    !byte 0
LVLCOMPLETE_NAME:
    ASC "LVLCOMPLETE.ZSM"
    !byte 0
BOTHPSG_NAME:
    ASC "BOTHPSG.ZSM"
    !byte 0
GARGOYLES_NAME:
    ASC "GARGOYLES.ZSM"
    !byte 0
TRACK2_NAME:
    ASC "TRACK2.ZSM"
    !byte 0
CMDRDEMO_NAME:
    ASC "CMDRDEMO.ZSM"
    !byte 0
SHOVELKNT_NAME:
    ASC "SHOVELKNT.ZSM"
    !byte 0
NAME_TBL:
    !word CANYON_NAME,TITLE_NAME,HIGHSCORE_NAME,GAMEOVER_NAME,KILLED_NAME,LVLCOMPLETE_NAME,BOTHPSG_NAME,GARGOYLES_NAME,TRACK2_NAME,CMDRDEMO_NAME,SHOVELKNT_NAME
SONG_TITLES:
    ASC "CANYON (ZSM LOOP)                    "
    ASC "TITLE (FM DRUMS)                     "
    ASC "HIGHSCORE                             "
    ASC "GAMEOVER (WORST CASE)                "
    ASC "KILLED                                "
    ASC "LEVEL COMPLETE                        "
    ASC "BOTHPSG (SMOKE TEST)                 "
    ASC "GARGOYLES (NO LOOP)                  "
    ASC "TRACK2 (FMMASK $1F)                  "
    ASC "CMDR DEMO (DUAL MASK)                "
    ASC "SHOVEL KNIGHT (PCM)                  "

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
MUTE:
    !byte 0
PAUSE:
    !byte 0
ERR:
    !byte 0
ERRCODE:
    !byte 0
DONE_FLAG:
    !byte 0
DEBUG_MARKER:
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
IRQ_ACTIVE:
    !byte 0
STREAM_END:
    !byte 0
EOF_FLAG:
    !byte 0
SONG_NUM:
    !byte 0
TCNT1:
    !byte 0
TCNT2:
    !byte 0
PATH_BUF:
    !byte 0
    !byte $FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF
    !byte $FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF
    !byte $FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF
    !byte $FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF,$FF
PATH_LEN:
    !byte $FF
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
    !byte 4,0,0,0,0
REF_NUM:
    !byte 0
SHORT_READ:
    !byte 0
BUF_END_L:
    !byte 0
BUF_END_H:
    !byte 0
; --- PCM state (full ZSM PCM support) ---
PCM_TBL_L:
    !byte 0
PCM_TBL_M:
    !byte 0
PCM_TBL_H:
    !byte 0
PCM_INST_MAX:
    !byte 0
PCM_DATA_BASE_L:
    !byte 0
PCM_DATA_BASE_M:
    !byte 0
PCM_DATA_BASE_H:
    !byte 0
PCM_INST:
    !byte 0
PCM_LOADED:
    !byte $FF
PCM_ENTRY:
    !byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
PCM_OFF_L:
    !byte 0
PCM_OFF_M:
    !byte 0
PCM_OFF_H:
    !byte 0
PCM_LEN_L:
    !byte 0
PCM_LEN_M:
    !byte 0
PCM_LEN_H:
    !byte 0
PCM_LOOPED:
    !byte 0
PCM_LOOP_L:
    !byte 0
PCM_LOOP_M:
    !byte 0
PCM_LOOP_H:
    !byte 0
PCM_FILE_OFF_L:
    !byte 0
PCM_FILE_OFF_M:
    !byte 0
PCM_FILE_OFF_H:
    !byte 0
PCM_FORMAT:
    !byte 0
PCM_VOLUME:
    !byte 0
PCM_CTRL:
    !byte 0
PCM_RATE:
    !byte 0
PCM_EFFRATE:
    !byte 0
PCM_BUDGET_L:
    !byte 0
PCM_BUDGET_H:
    !byte 0
PCM_POS_L:
    !byte 0
PCM_POS_M:
    !byte 0
PCM_POS_H:
    !byte 0
PCM_FED_L:
    !byte 0
PCM_FED_H:
    !byte 0
PCM_ACTIVE:
    !byte 0
PCM_SUB:
    !byte 0
PCM_VAL:
    !byte 0
PCM_EVCOUNT:
    !byte 0
PCM_TMP:
    !byte 0
    !byte 0        ; PCM_TMP+1
PCM_DST_L:
    !byte 0
PCM_DST_H:
    !byte 0
PCM_COUNT_L:
    !byte 0
PCM_COUNT_M:
    !byte 0
PCM_COUNT_H:
    !byte 0
PCM_CHUNK_L:
    !byte 0
PCM_CHUNK_H:
    !byte 0
PCM_REF:
    !byte 0
PCM_FP_ADDR_L:
    !byte 0
PCM_FP_ADDR_H:
    !byte 0
ERRSRC:
    !byte 0
; --- seek / restart / loop state ---
LOOP_EN:
    !byte 1
SEEK_CNT_L:
    !byte 0
SEEK_CNT_H:
    !byte 0
TARG_L:
    !byte 0
TARG_H:
    !byte 0
SEEK_TMP:
    !byte 0
