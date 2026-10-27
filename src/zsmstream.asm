; ==============================================================================
; ZSMSTREAM.ASM — Apple II ZSM Jukebox Player (VERA PSG + YM2151 FM)
; Companion to fmtest.asm (FM sound test). Streams a real ZSM song
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
; Tick-rate normalization follows zsmkit: ZSM ticks are consumed at
; TICKRATE/60 per 60 Hz output frame (remainder carried in FRAC), and all
; ticks that fall inside one output frame are merged into that frame. So a
; 240 Hz song (Headbanger!) still puts one frame on the wire per VSYNC, with
; four ZSM ticks' register writes applied together. Rates below 60 publish a
; hold frame when no tick is due.
;
; Frame ring (8 x 512 B, so the decoder can run up to 7 frames ahead) at
;   $6F00..$7EFF; the YM2151 pair accumulator lives at $5400 so the whole ring
;   fits above it:
;   [psgCnt][reg,val]x psgCnt [ymCnt][reg,val]x ymCnt   (psgCnt=$FF = hold frame)
;   The decoder builds the next frame in ring slot FB_HEAD and publishes it by
;   advancing FB_HEAD / bumping FB_CNT under SEI; the IRQ applies ring slot
;   FB_TAIL and pops it. Because seven frames of lookahead are allowed, a slow
;   pass in the main loop (a 4 KB PCM window read, a 512 B stream refill) no
;   longer costs a tick: the IRQ keeps consuming frames already published.
;   A tick is only skipped (TICK_NOFRAME) if the decoder fell more than seven
;   frames behind.
;
; PCM: one 4 KB window ($4400-$53FF) holds a whole drum sample (measured:
;   2667 B for Crockett), so a trigger costs one MLI read instead of two. The
;   window is also reused in place: PCM_FILL_WINDOW compares the requested file
;   position and length against PCM_CPOS/PCM_CLEN and, on a match, feeds the
;   bytes already in PCM_BUFFER without touching the disk. Drum samples repeat
;   for the whole song, so nearly every hit after the first is free. Feeding
;   only moves PCM_PTR, never the data, so a partially-fed window is still a
;   valid cache entry; a failed read poisons PCM_CPOS_H ($FF) to invalidate it.
;
; Controls (in song): ESC/Q = stop -> menu, P/space = pause, M = mute,
;   +/- = vol, ]/[ = forward/backward 5 s, R = restart, L = loop toggle.
;   Pause and mute do not leave the last chord ringing: they zero the 16 PSG
;   voices, mute the PCM fifo and release all eight YM2151 channels, and
;   restoring re-sends the state that was cut (PSG_SHADOW, PCM_CTRL, FM_KEYS).
; Menu: digit 1-9,0 selects song; ESC/Q exits to BASIC (RTS).
; External-name mode (used by the MELODIUS jukebox BASIC menus): BASIC writes
; 'M','Z' at $6800 and a NUL-terminated ProDOS name at $6802, then BRUNs the
; player with the ProDOS prefix set to the song's folder. The player plays
; that file directly and RTSes back to BASIC when the song ends or ESC/Q is
; pressed, so the menu program resumes where it left off.
; AUTOPLAY = 1 (injected via --autoplay build) auto-starts song 0 for headless.
;
; Conventions: asm6502.mjs injects VERA_BASE ($C200/$C400) and FM_BASE ($C0A0/$C0C0),
; $2000 BRUN, dual slot. Code below $3F00. Zero page $06-$37.
; ==============================================================================

* = $2000

MLI         = $BF00
STREAM_L = $06       ; feeder pointer into $4000 buffer (zp)
STREAM_H = $07
CNT      = $08
FRAC     = $09       ; tick-rate remainder accumulator (decoder, 0..59)
TICKRATE = $0A       ; ZSM tick rate (header bytes 12-13, low byte)
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
FB_CNT   = $16       ; IRQ: published frames waiting (0..FB_MAX)
FB_HEAD  = $17       ; IRQ: ring slot the decoder publishes from / writes next
FB_TAIL  = $18       ; IRQ: ring slot to consume next
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
FB_RD_L = $36        ; IRQ frame-read pointer (16-bit: a frame can exceed 255 B)
FB_RD_H = $37
; PCM window pointer uses $03/$04: Applesoft leaves $00-$05 free, and the
; $06-$37 block is snapshotted/restored around BASIC, so this is outside it.
PCM_PTR_L = $03
PCM_PTR_H = $04

BUF_LO  = $4000      ; 512-byte stream block buffer
BUF_HI  = $4200
FB_RING = $6F00      ; 8 x 512 B published-frame ring ($6F/$71/$73/$75/$77/$79/$7B/$7D xx00)
FB_RING_H0 = $6F     ; high byte of slot 0; slot n is at (FB_RING_H0 + 2*n)*$100
FB_SLOTS = 8
FB_MAX  = 7          ; published frames allowed: one ring slot is the writer's
YM_SCRATCH = $5400   ; YM pair accumulation buffer (512 B)  -- free block above PCM_BUFFER2
FILE_BUF = $6000
PCM_BUFFER = $4400   ; PCM window (4096 B, $4400-$53FF) -- streamed from disk
PCM_BUFFER2 = $4C00  ; unused: the prefetch that needed a second buffer is
                      ; disabled (the 4 KB window swallows a whole drum)
PCM_BUFFER_SIZE = $1000
PCM_FILE_BUF = $6400 ; PCM refnum FCB (1024 B) -- free RAM below FILE_BUF+$400
EXT_MAGIC = $6800    ; BASIC menu: 'M','Z' marker (survives BRUN)
EXT_NAME  = $6802    ; BASIC menu: NUL-terminated ProDOS name (max 15)
INFO_TITLE = $6818   ; BASIC menu: NUL-terminated song title (15 chars)
INFO_CAT   = $6828   ; BASIC menu: NUL-terminated category label (max 27)
INFO_DUR   = $6850   ; BASIC menu: NUL-terminated "(m:ss)" song length
ZP_SAVE   = $6A00    ; snapshot of Applesoft zero page $06-$37 (50 B)

AUTOPLAY = 0         ; release: menu only. --autoplay build injects AUTOPLAY=1.
AUTOSONG = 0         ; which song index AUTOPLAY auto-starts (injectable).

START:
    SEI
    CLD                   ; ADC below assumes binary mode
    ; Applesoft keeps live interpreter state in zero page $06-$37. We are
    ; CALLed from BASIC, so snapshot it now and restore before any RTS back.
    LDX #$00
ZP_SAVE_LOOP:
    LDA $06,X
    STA ZP_SAVE,X
    INX
    CPX #$32              ; 50 bytes: $06..$37
    BNE ZP_SAVE_LOOP
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

MENU:
    ; External-name mode: BASIC sets 'M','Z' + a filename before BRUN.
    ; Play it once, then RTS so the BASIC menu resumes after BRUN.
    LDA EXT_MAGIC
    CMP #$4D              ; 'M'
    BNE MENU_STD
    LDA EXT_MAGIC+1
    CMP #$5A              ; 'Z'
    BNE MENU_STD
    LDA EXT_PLAYED
    BNE MENU_EXT_RTS
    LDA #$01
    STA EXT_PLAYED
    JMP PLAY_SONG
MENU_EXT_RTS:
    JSR RESTORE_ZP
    RTS
MENU_STD:
    JSR CLEAR_SCREEN
    JSR DRAW_MENU
    LDA #AUTOPLAY
    BEQ MENU_WAIT_KEY
    ; autoplay build: play AUTOSONG without touching the menu
    LDA #AUTOSONG
    STA SONG_NUM
    JMP PLAY_SONG
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
    ; Resolve song name pointer: external $6802 buffer, or NAME_TBL[SONG_NUM]
    LDA EXT_MAGIC
    CMP #$4D              ; 'M'
    BNE PS_TABLE
    LDA EXT_MAGIC+1
    CMP #$5A              ; 'Z'
    BNE PS_TABLE
    LDA #<EXT_NAME
    STA NAME_PTR_L
    LDA #>EXT_NAME
    STA NAME_PTR_H
    JMP PS_NAME_SET
PS_TABLE:
    LDA SONG_NUM
    ASL A                 ; *2
    TAY
    LDA NAME_TBL,Y
    STA NAME_PTR_L
    LDA NAME_TBL+1,Y
    STA NAME_PTR_H
PS_NAME_SET:
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
    JSR SHOW_INFO
    ; Initialize the frame ring: nothing published yet, first decode fills slot 0.
    LDA #$00
    STA FB_CNT
    STA FB_HEAD
    STA FB_TAIL
    STA WRB_BASE_L
    LDA #FB_RING_H0       ; ring slot 0 high byte
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
    LDA PAUSE            ; paused: the ring is held, so decoding here would
    BNE MAIN_KEYS        ; spin on FB_CNT and never scan the keyboard again
    JSR DECODE_FRAME
MAIN_KEYS:
    INC ST_DIV            ; the status line is a display: redraw it about
    LDA ST_DIV            ; 7 times a second, not once per decoded frame
    AND #$07
    BNE ST_SKIP
    JSR SHOW_STATUS
ST_SKIP:
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
    JSR GETB               ; tickRate high (library rates all fit in a byte)
    JSR GETB               ; reserved (header offset 0x0e)
    JSR GETB               ; reserved (header offset 0x0f)
    ; Normalize the tick rate to the 60 Hz output frame: TICKS_PER_FRM whole
    ; ticks per frame plus a TICK_REM/60 remainder carried in FRAC.
    LDA TICKRATE
    BNE RH_RATE_OK
    LDA #60               ; malformed header: fall back to 60 Hz
    STA TICKRATE
RH_RATE_OK:
    LDA #$00
    STA TICKS_PER_FRM
    LDA TICKRATE
RH_RATE_DIV:
    CMP #60
    BCC RH_RATE_DONE
    SBC #60
    INC TICKS_PER_FRM
    JMP RH_RATE_DIV
RH_RATE_DONE:
    STA TICK_REM
    ; Set up PCM if the song has a PCM table (pcmTableOffset != 0).
    JSR READ_PCM_SETUP
    LDA STREAM_END
    BEQ RH_DONE
    LDA #$01
    STA ERR
RH_DONE:
    RTS

; --------------------------------------------------------------------------
; DECODE_FRAME — produce one 60 Hz output frame. Normalizes the ZSM tick rate
; (zsmkit semantics): advance TICKRATE/60 source ticks, merging their events
; into the frame, and publish once. If no source tick is due yet (rate < 60),
; publish a hold frame. EOD -> DONE_FLAG.
; --------------------------------------------------------------------------
DECODE_FRAME:
    ; source ticks this frame = TICKS_PER_FRM + carry from FRAC + TICK_REM
    LDA FRAC
    CLC
    ADC TICK_REM
    CMP #60
    BCC DF_NO_CARRY
    SBC #60               ; carry set
    STA FRAC
    LDA TICKS_PER_FRM
    CLC
    ADC #$01
    JMP DF_SET_N
DF_NO_CARRY:
    STA FRAC
    LDA TICKS_PER_FRM
DF_SET_N:
    STA TICKS_LEFT
    BNE DF_START
    JSR PUBLISH_HOLD
    RTS
DF_START:
    JSR FRAME_START
    LDA #$00
    STA FRAME_PUB
DF_TICK_LOOP:
    JSR DECODE_ONE_TICK
    LDA FRAME_PUB
    BNE DF_RET            ; EOD / stream end already published the frame
    DEC TICKS_LEFT
    BNE DF_TICK_LOOP
    JSR PUBLISH_FRAME
DF_RET:
    RTS

; --------------------------------------------------------------------------
; DECODE_ONE_TICK — advance the stream by one ZSM tick. Events accumulate in
; the current frame; a delay consumes tick slots via HOLD_LEFT. On EOD or a
; truncated stream the partial frame is published and FRAME_PUB set.
; FRM0/1/2 count source ticks, keeping [ ] seeks correct at any tick rate.
; --------------------------------------------------------------------------
DECODE_ONE_TICK:
    INC FRM0
    BNE DOT_NO1
    INC FRM1
    BNE DOT_NO1
    INC FRM2
DOT_NO1:
    LDA HOLD_LEFT
    BEQ DF_NORMAL
    DEC HOLD_LEFT
    RTS
DF_NORMAL:
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
    RTS
DF_EOD:
    JSR PUBLISH_FRAME
    LDA #$01
    STA FRAME_PUB
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
    LDA #$01
    STA FRAME_PUB
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
    LDA #>YM_SCRATCH     ; YM accumulation buffer (moved to $7B00)
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
    ; A = reg, VAL_TMP = val. YM pairs accumulate in YM_SCRATCH ($7D00),
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
; PUBLISH_FRAME — finalize frame, publish it into the ring, advance FB_HEAD.
; Waits while the ring is full (FB_CNT == FB_MAX), i.e. the decoder may run up
; to three frames ahead of the IRQ. PCM is fed once per published frame.
; --------------------------------------------------------------------------
PUBLISH_FRAME:
    JSR PCM_FEED            ; bounded (<=256 B) FIFO top-up, once per frame
    LDA IRQ_ACTIVE
    BEQ PUB_NOWAIT
PUB_WAIT:
    LDA FB_CNT
    CMP #FB_MAX
    BCS PUB_WAIT
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
    LDA #>YM_SCRATCH
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
    ; publish the frame just built in ring slot FB_HEAD, then point the write
    ; buffer at the next slot (there is always one spare: FB_CNT <= FB_MAX-1
    ; here, and the ring has FB_SLOTS = FB_MAX+1 buffers).
    INC FB_CNT
    LDA FB_HEAD
    CLC
    ADC #$01
    CMP #FB_SLOTS
    BCC PUB_HEAD_OK
    LDA #$00              ; wrap 4 -> 0
PUB_HEAD_OK:
    STA FB_HEAD
    ASL A                 ; slot n high byte = $73 + 2*n
    CLC
    ADC #FB_RING_H0
    STA WRB_BASE_H
    STA FRAME_H
    LDA #$00
    STA WRB_BASE_L
    STA FRAME_L
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
; Waits until the IRQ has consumed every published frame (FB_CNT==0), SET_MARKs the file cursor, refills.
; Returns CLC on success; on failure SEC + ERR=1 + DEBUG_MARKER=$13 (MAIN
; reports DISK_FAIL).  One-frame IRQ gap is natural (hardware sustains).
SEEK_TO:
    LDA IRQ_ACTIVE
    BEQ ST_NOWAIT
ST_WAIT:
    LDA FB_CNT
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
; policy).  Requires FB_CNT==0 (the IRQ has no frame left to apply).
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
    CMP #$81
    BCC SS_YM
    ; $81-$FF: tick delay, one byte already consumed by GETB. The old branch
    ; fell into SS_YM and ate the next (cmd&$3F)*2 bytes as fake YM pairs:
    ; Crockett has 5,605 delay commands, so the ]/[ seek ran ~11,210 bytes
    ; past where the decoder was and the frame count went wildly wrong.
    ; DECODE_FRAME semantics: HOLD_LEFT = (cmd&$7F)-1, consume this frame.
    LDA CMD
    AND #$7F
    SEC
    SBC #$01
    STA HOLD_LEFT
    CLC
    RTS
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

; CALC_SEEK_TICKS — SEEK_CNT = 5 seconds of source ticks = 5 * TICKRATE.
; SEEK_STEP advances one source tick, so the distance scales with the tick
; rate (Headbanger! at 240 Hz needs 1200 ticks, not 300).
CALC_SEEK_TICKS:
    LDA TICKRATE
    STA SEEK_CNT_L
    LDA #$00
    STA SEEK_CNT_H
    ASL SEEK_CNT_L
    ROL SEEK_CNT_H
    ASL SEEK_CNT_L
    ROL SEEK_CNT_H
    LDA SEEK_CNT_L
    CLC
    ADC TICKRATE
    STA SEEK_CNT_L
    LDA SEEK_CNT_H
    ADC #$00
    STA SEEK_CNT_H
    RTS

; DO_SEEK_FWD — fast-forward 5 s.  Decodes 5*TICKRATE source ticks through
; SEEK_STEP (SHADOW-only, no publish), then restores the PSG from SHADOW.
; On EOD+loop the file cursor ends up at loopOffset; on EOD with no loop
; DONE_FLAG=1 (MAIN -> SONG_DONE).  Clock jumps +5 s.
DO_SEEK_FWD:
    LDA IRQ_ACTIVE
    BEQ SF_NOWAIT
SF_WAIT:
    LDA FB_CNT
    BNE SF_WAIT
SF_NOWAIT:
    JSR CALC_SEEK_TICKS
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

; DO_SEEK_BWD — rewind 5 s (5*TICKRATE source ticks, clamped at song start).
; SET_MARK(0) the file cursor, clear SHADOW, fast-scan TARG ticks, clock
; -= 5 s (with borrow).  FRM0/1/2 restart from 0 and end at TARG.
DO_SEEK_BWD:
    LDA IRQ_ACTIVE
    BEQ SB_NOWAIT
SB_WAIT:
    LDA FB_CNT
    BNE SB_WAIT
SB_NOWAIT:
    JSR CALC_SEEK_TICKS
    SEC
    LDA FRM0
    SBC SEEK_CNT_L
    STA TARG_L
    LDA FRM1
    SBC SEEK_CNT_H
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
    LDA FB_CNT
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
    JSR SHOW_LOOP_TAG
    JMP MAIN

; --------------------------------------------------------------------------
; PCM support (full ZSM: PSG + FM + PCM). A sample is streamed from the
; companion file in PCM_BUFFER_SIZE windows and pushed into the VERA audio
; FIFO ($Cn1D) by PCM_FEED, the 128-byte bounded page-indexed feeder from
; pcmstream.asm; the FIFO-full flag is the only pacing, exactly as zsmkit's
; _pcm_player treats the hardware. A 2nd refnum (PCM_REF) keeps the main ZSM
; stream cursor untouched.
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
    BNE RPS_SKIP
    ; OPEN_PCM clears the header flag when there is no companion file.
    LDA PCM_TBL_L
    ORA PCM_TBL_M
    ORA PCM_TBL_H
    BEQ RPS_SKIP
    JMP RPS_OK
RPS_SKIP:
    RTS
RPS_OK:
    ; The companion file starts at the ZSM's pcmTableOffset, so the table is at 0.
    LDA PCM_REF
    STA SETMARK_PARAMS+1
    LDA #$00
    STA SETMARK_PARAMS+2
    STA SETMARK_PARAMS+3
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
    CMP #$50              ; 'P'
    BNE RPS_NOMAGIC
    LDA PCM_TMP+1
    CMP #$43              ; 'C'
    BNE RPS_NOMAGIC
    LDA PCM_TMP+2
    CMP #$4D              ; 'M'
    BNE RPS_NOMAGIC
    LDA PCM_TMP+3
    STA PCM_INST_MAX
RPS_NOMAGIC:
RPS_CALC:
    ; DATA_BASE = 20 + (instMax<<4), relative to the companion file
    LDA #$14
    STA PCM_DATA_BASE_L
    LDA #$00
    STA PCM_DATA_BASE_M
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

; OPEN_PCM — open the companion "<name>.PCM" file that the build step split out
; of the ZSM at pcmTableOffset. ProDOS 8 refuses a second FCB on a file that is
; already open ($50), so the samples have to live in their own file.
OPEN_PCM:
    LDA #$00
    STA ERR
    ; OPEN_PARAMS+5 is the slot/drive input *and* the refnum output, so the
    ; previous OPEN left a refnum here; 0 means "use the current prefix".
    STA OPEN_PARAMS+5
    LDA #$03
    STA OPEN_PARAMS
    LDA #<PCM_FILE_BUF
    STA OPEN_PARAMS+3
    LDA #>PCM_FILE_BUF
    STA OPEN_PARAMS+4
    JSR SWAP_PCM_EXT
    JSR MLI
    !byte $C8
    !word OPEN_PARAMS
    BCS OPEN_PCM_ERR      ; carry set = MLI error, A = error code
    LDA OPEN_PARAMS+5
    STA PCM_REF
    RTS
OPEN_PCM_ERR:
    CMP #$46              ; file not found -> play the song without its samples
    BNE OPEN_PCM_FAIL
    LDA #$00
    STA PCM_TBL_L
    STA PCM_TBL_M
    STA PCM_TBL_H
    RTS
OPEN_PCM_FAIL:
    STA ERRCODE
    LDA #$44
    STA ERRSRC
    LDA #$01
    STA ERR
    RTS

; SWAP_PCM_EXT — rewrite the trailing "ZSM" of PATH_BUF as "PCM". The name is a
; Pascal string, so its last character sits at PATH_BUF+length.
SWAP_PCM_EXT:
    LDA PATH_BUF
    TAX
    LDA #$50              ; 'P'
    STA PATH_BUF-2,X
    LDA #$43              ; 'C'
    STA PATH_BUF-1,X
    LDA #$4D              ; 'M'
    STA PATH_BUF,X
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
    ; effRate = (rate>128)?(256-rate):rate -- VERA's own conversion, kept only
    ; to print the sample rate in the status line.
    CMP #$80
    BCC PCM_RATE_LE128
    LDA #$00
    SEC
    SBC PCM_RATE
    STA PCM_EFFRATE
    JMP PCM_RATE_WRITE
PCM_RATE_LE128:
    LDA PCM_VAL
    STA PCM_EFFRATE
PCM_RATE_WRITE:
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

; PCM_TRIGGER — A = instrument idx. Read its 16-byte entry from the companion
; file's table, then start streaming its sample data in PCM_BUFFER_SIZE windows.
PCM_TRIGGER:
    STA PCM_INST
    ; entryAddr = 4 + (idx<<4), relative to the companion file
    LDA #$04
    STA SETMARK_PARAMS+2
    LDA #$00
    STA SETMARK_PARAMS+3
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
    ; The sample is streamed from disk in PCM_BUFFER_SIZE windows while it
    ; plays, so a trigger only has to reset the position.
    LDA #$00
    STA PCM_POS_L
    STA PCM_POS_M
    STA PCM_POS_H
    STA PP_LEFT_L
    STA PP_LEFT_H
    ; a loop point at/after the end would make PCM_FEED spin without
    ; advancing the byte counter, so treat it as non-looped
    LDA PCM_LOOPED
    BEQ PT_START
    LDA PCM_LOOP_H
    CMP PCM_LEN_H
    BCC PT_START
    BNE PT_LOOP_OFF
    LDA PCM_LOOP_M
    CMP PCM_LEN_M
    BCC PT_START
    BNE PT_LOOP_OFF
    LDA PCM_LOOP_L
    CMP PCM_LEN_L
    BCC PT_START
PT_LOOP_OFF:
    LDA #$00
    STA PCM_LOOPED
PT_START:
    LDA #$01
    STA PCM_ACTIVE
    ; zsmkit's _pcm_trigger_instrument nukes the FIFO on every trigger
    ; ("nuke any fifo contents immediately", zsmkit.s line 1054) so a new
    ; drum never starts from the previous drum's queued bytes. On the //e
    ; the queued leftovers are exactly what made Crockett crackle: the
    ; hardware keeps eating the old drum's bytes at the old rate while the
    ; new trigger's bytes queue behind them. Flush before refilling.
    LDA PCM_CTRL
    ORA #$80
    STA VERA_AUDIO_CTRL
    ; zsmkit/_pcm_player holds AudioRate at 0 while the FIFO is cold so the
    ; prefill isn't drained as it is written. On the //e that also covers the
    ; milliseconds a disk window refill costs.
    LDA #$00
    STA VERA_AUDIO_RATE
    JSR PCM_WRITE_CTRL

    JSR PCM_FILL_WINDOW
    LDA PCM_IOERR
    BNE PT_FAIL
    LDA PCM_ACTIVE
    BEQ PT_RTS
    ; The window just read covers the whole sample in the usual case, so only
    ; the feed cursor has to be armed. PCM_WIN/PCM_PRE belong to the disabled
    ; prefetch machinery (see "PCM staging" below) and stay cleared.
    LDA #$00
    STA PCM_WIN
    STA PCM_PRE
    LDA #<PCM_BUFFER
    STA PCM_PTR_L
    LDA #>PCM_BUFFER
    STA PCM_PTR_H
    LDA PCM_POS_L
    CLC
    ADC PP_LEFT_L
    STA PCM_LOAD_L
    LDA PCM_POS_M
    ADC PP_LEFT_H
    STA PCM_LOAD_M
    LDA PCM_POS_H
    ADC #$00
    STA PCM_LOAD_H
    JSR PCM_PREFILL
    JSR PCM_ARM_PRE
    LDA PCM_RATE
    STA VERA_AUDIO_RATE
PT_RTS:
    RTS
PT_FAIL:
    ; No sample data: leave the drums off but keep the song playing.
    LDA #$00
    STA PCM_ACTIVE
    RTS

; PCM_FILL_WINDOW — load the next window of the current sample (starting at
; sample position PCM_POS) into PCM_BUFFER and arm the feed cursor (PCM_PTR /
; PP_LEFT). Sets PCM_ACTIVE=0 when the sample is exhausted and PCM_IOERR if the
; disk access fails. PCM_IOERR is private so a sample read never aborts the
; song the way a stream error does.
PCM_FILL_WINDOW:
    LDA #$00
    STA PCM_IOERR
    STA PP_LEFT_L
    STA PP_LEFT_H
    ; filePos = PCM_FILE_OFF + PCM_POS
    LDA PCM_FILE_OFF_L
    CLC
    ADC PCM_POS_L
    STA PCM_FPOS_L
    LDA PCM_FILE_OFF_M
    ADC PCM_POS_M
    STA PCM_FPOS_M
    LDA PCM_FILE_OFF_H
    ADC PCM_POS_H
    STA PCM_FPOS_H
    ; count = min(PCM_LEN - PCM_POS, PCM_BUFFER_SIZE)
    LDA PCM_LEN_L
    SEC
    SBC PCM_POS_L
    STA PCM_COUNT_L
    LDA PCM_LEN_M
    SBC PCM_POS_M
    STA PCM_COUNT_M
    LDA PCM_LEN_H
    SBC PCM_POS_H
    STA PCM_COUNT_H
    LDA PCM_COUNT_H
    BNE PFW_CAP
    LDA PCM_COUNT_M
    CMP #>PCM_BUFFER_SIZE
    BCC PFW_MARK
PFW_CAP:
    LDA #$00
    STA PCM_COUNT_L
    STA PCM_COUNT_H
    LDA #>PCM_BUFFER_SIZE
    STA PCM_COUNT_M
PFW_MARK:
    ; The window still in PCM_BUFFER can be reused verbatim when a trigger
    ; asks for the same file position and length again (drum samples repeat
    ; for the whole song, and feeding only moves PCM_PTR, never the data).
    LDA PCM_CPOS_L
    CMP PCM_FPOS_L
    BNE PFW_LOAD
    LDA PCM_CPOS_M
    CMP PCM_FPOS_M
    BNE PFW_LOAD
    LDA PCM_CPOS_H
    CMP PCM_FPOS_H
    BNE PFW_LOAD
    LDA PCM_CLEN_L
    CMP PCM_COUNT_L
    BNE PFW_LOAD
    LDA PCM_CLEN_M
    CMP PCM_COUNT_M
    BNE PFW_LOAD
    LDA #<PCM_BUFFER          ; cache hit: no disk read at all
    STA PCM_PTR_L
    LDA #>PCM_BUFFER
    STA PCM_PTR_H
    LDA PCM_COUNT_L
    STA PP_LEFT_L
    LDA PCM_COUNT_M
    STA PP_LEFT_H
    RTS
PFW_LOAD:
    LDA PCM_REF
    STA SETMARK_PARAMS+1
    LDA PCM_FPOS_L
    STA SETMARK_PARAMS+2
    LDA PCM_FPOS_M
    STA SETMARK_PARAMS+3
    LDA PCM_FPOS_H
    STA SETMARK_PARAMS+4
    JSR MLI
    !byte $CE
    !word SETMARK_PARAMS
    BCC PFW_READ
    STA ERRCODE
    LDA #$47
    STA ERRSRC
    LDA #$01
    STA PCM_IOERR
    LDA #$FF                 ; buffer contents unknown now
    STA PCM_CPOS_H
    RTS
PFW_READ:
    LDA PCM_REF
    STA READ_PARAMS+1
    LDA #<PCM_BUFFER
    STA READ_PARAMS+2
    LDA #>PCM_BUFFER
    STA READ_PARAMS+3
    LDA PCM_COUNT_L
    STA READ_PARAMS+4
    LDA PCM_COUNT_M
    STA READ_PARAMS+5
    JSR MLI
    !byte $CA
    !word READ_PARAMS
    BCC PFW_DONE
    CMP #$4C
    BEQ PFW_EMPTY
    STA ERRCODE
    LDA #$48
    STA ERRSRC
    LDA #$01
    STA PCM_IOERR
    LDA #$FF
    STA PCM_CPOS_H
    RTS
PFW_DONE:
    ; Arm the feed cursor: PCM_BUFFER holds the window that starts at sample
    ; position PCM_POS, PP_LEFT bytes of it are still unfed.
    LDA #<PCM_BUFFER
    STA PCM_PTR_L
    LDA #>PCM_BUFFER
    STA PCM_PTR_H
    LDA PCM_FPOS_L
    STA PCM_CPOS_L
    LDA PCM_FPOS_M
    STA PCM_CPOS_M
    LDA PCM_FPOS_H
    STA PCM_CPOS_H
    LDA READ_PARAMS+6
    ORA READ_PARAMS+7
    BEQ PFW_EMPTY
    LDA READ_PARAMS+6
    STA PCM_CLEN_L
    LDA READ_PARAMS+7
    STA PCM_CLEN_M
    STA PP_LEFT_H
    LDA READ_PARAMS+6
    STA PP_LEFT_L
    LDA READ_PARAMS+7
    STA PP_LEFT_H
    RTS
PFW_EMPTY:
    ; A short/empty read is the logical end of the sample.
    LDA #$00
    STA PCM_ACTIVE
PFW_RTS:
    RTS


; PCM_FEED — top up the VERA PCM FIFO from the staged window. Ported from
; pcmstream.asm's FEED_BLOCK_BYTES, the feeder the jukebox PCM tracks are
; known-good with: a page-indexed loop of at most 128 bytes that exits on the
; FIFO-full flag, ~25 cycles per byte, with the window refill done once per
; window instead of once per byte. The previous version recomputed the 24-bit
; sample position, the window bounds and the buffer address for *every* byte
; (~140 cycles), so a 27 kHz track needed 3.9M cycles/s -- more than the //e
; has at any speed. The FIFO then starves, VERA outputs silence on underrun,
; and on a signal as small as TREE's (a few LSBs of swing) the dropouts are
; what sounded like noise.
PF_NO:
    RTS

PCM_FEED:
    LDA PAUSE
    BNE PF_NO                 ; frozen clock: don't queue audio behind the pause
    LDA PCM_ACTIVE
    BEQ PF_NO
    ; VERA_ISR bit 3 is AFLOW: the FIFO holds fewer than 1024 bytes, so it
    ; has at least 3072 free and a 384-byte burst cannot overrun. That is
    ; what lets the loop write without polling the FIFO once per byte: 23
    ; cycles/byte was 8 KB/s of FIFO at 18 % of the CPU, and on BlankPage
    ; that alone pushed the decode loop past one frame (dropped ticks).
    LDA VERA_ISR
    AND #$08
    BEQ PF_NO
    LDA #$03
    STA PP_PASSES             ; up to 3 x 128 bytes per call: one window in 11
PF_PASS:
    LDA PP_LEFT_L
    ORA PP_LEFT_H
    BNE PF_HAVE_LEFT
    JMP PF_WINDOW_OUT
PF_HAVE_LEFT:
    LDA PP_LEFT_H
    BNE PF_BLOCK
    LDA PP_LEFT_L
    CMP #$80
    BCS PF_BLOCK
    ; fewer than 128 bytes left in the window: drain them one by one
    LDY #$00
PF_TAIL:
    LDA (PCM_PTR_L),Y
    STA VERA_AUDIO_DATA
    INY
    CPY PP_LEFT_L
    BNE PF_TAIL
    JMP PF_FED
PF_BLOCK:
    LDY #$00
    LDX #$10                  ; 16 blocks of 8 bytes = 128
PF_BLOCK_LOOP:
    LDA (PCM_PTR_L),Y
    STA VERA_AUDIO_DATA
    INY
    LDA (PCM_PTR_L),Y
    STA VERA_AUDIO_DATA
    INY
    LDA (PCM_PTR_L),Y
    STA VERA_AUDIO_DATA
    INY
    LDA (PCM_PTR_L),Y
    STA VERA_AUDIO_DATA
    INY
    LDA (PCM_PTR_L),Y
    STA VERA_AUDIO_DATA
    INY
    LDA (PCM_PTR_L),Y
    STA VERA_AUDIO_DATA
    INY
    LDA (PCM_PTR_L),Y
    STA VERA_AUDIO_DATA
    INY
    LDA (PCM_PTR_L),Y
    STA VERA_AUDIO_DATA
    INY
    DEX
    BNE PF_BLOCK_LOOP
PF_FED:
    ; Y = bytes pushed this pass
    TYA
    BEQ PF_RTS
    STY PP_TMPY
    ; PCM_PTR += Y
    CLC
    ADC PCM_PTR_L
    STA PCM_PTR_L
    BCC PF_PTR_DONE
    INC PCM_PTR_H
PF_PTR_DONE:
    ; PP_LEFT -= Y
    LDA PP_LEFT_L
    SEC
    SBC PP_TMPY
    STA PP_LEFT_L
    LDA PP_LEFT_H
    SBC #$00
    STA PP_LEFT_H
    ; PCM_POS += Y (once per pass, not once per byte)
    LDA PCM_POS_L
    CLC
    ADC PP_TMPY
    STA PCM_POS_L
    LDA PCM_POS_M
    ADC #$00
    STA PCM_POS_M
    LDA PCM_POS_H
    ADC #$00
    STA PCM_POS_H
    DEC PP_PASSES
    BNE PF_MORE
    RTS
PF_MORE:
    JMP PF_PASS
PF_RTS:
    RTS

PF_WINDOW_OUT:
    ; The staged window ran out. At the end of the sample?
    LDA PCM_POS_H
    CMP PCM_LEN_H
    BCC PF_REFILL
    BNE PF_SAMPLE_END
    LDA PCM_POS_M
    CMP PCM_LEN_M
    BCC PF_REFILL
    BNE PF_SAMPLE_END
    LDA PCM_POS_L
    CMP PCM_LEN_L
    BCC PF_REFILL
PF_SAMPLE_END:
    ; zsmkit/_pcm_player: a looped instrument restarts at its loop point, an
    ; unlooped one frees the PCM channel.
    LDA PCM_LOOPED
    BNE PF_LOOP_POINT
    JMP PF_STOP
PF_LOOP_POINT:
    LDA PCM_LOOP_L
    STA PCM_POS_L
    STA PCM_LOAD_L
    LDA PCM_LOOP_M
    STA PCM_POS_M
    STA PCM_LOAD_M
    LDA PCM_LOOP_H
    STA PCM_POS_H
    STA PCM_LOAD_H
    LDA #$00                 ; staged window is stale after a loop jump
    STA PCM_PRE
PF_REFILL:
    LDA PCM_PRE
    BNE PF_SWAP
    ; Nothing staged (trigger, loop point, sample shorter than one window):
    ; read the window now, into buffer 0.
PF_REFILL_SYNC:
    LDA #$00
    STA PCM_WIN
    LDA #<PCM_BUFFER
    STA PCM_PTR_L
    LDA #>PCM_BUFFER
    STA PCM_PTR_H
    JSR PCM_FILL_WINDOW
    ; A failed window read only stops the drums, not the song.
    LDA PCM_IOERR
    BNE PF_STOP
    LDA PCM_ACTIVE
    BEQ PF_RTS
    LDA PCM_POS_L           ; PCM_LOAD = PCM_POS + staged bytes
    CLC
    ADC PP_LEFT_L
    STA PCM_LOAD_L
    LDA PCM_POS_M
    ADC PP_LEFT_H
    STA PCM_LOAD_M
    LDA PCM_POS_H
    ADC #$00
    STA PCM_LOAD_H
    JMP PF_REFILL_PRE
PF_SWAP:
    ; Use the window that was staged in the spare buffer. It is normally long
    ; finished (PCM_PRE_STEP reads it in halves while the other window plays);
    ; a very long stall can leave it half-read, so finish it here.
PF_SWAP_WAIT:
    LDA PCM_PRE_LEFT_L
    ORA PCM_PRE_LEFT_M
    BEQ PF_SWAP_DONE
    JSR PCM_PRE_STEP
    LDA PCM_PRE
    BNE PF_SWAP_WAIT
    JMP PF_STOP             ; staging failed
PF_SWAP_DONE:
    LDA PCM_WIN
    EOR #$01
    STA PCM_WIN
    JSR PCM_WIN_PTR
    LDA PCM_PRE_LEN_L
    STA PP_LEFT_L
    LDA PCM_PRE_LEN_M
    STA PP_LEFT_H
    LDA PCM_LOAD_L          ; PCM_LOAD += the staged window's length
    CLC
    ADC PCM_PRE_LEN_L
    STA PCM_LOAD_L
    LDA PCM_LOAD_M
    ADC PCM_PRE_LEN_M
    STA PCM_LOAD_M
    LDA PCM_LOAD_H
    ADC #$00
    STA PCM_LOAD_H
    LDA #$00
    STA PCM_PRE
PF_REFILL_PRE:
    JSR PCM_ARM_PRE
    JMP PF_PASS
PF_STOP:
    LDA #$00
    STA PCM_ACTIVE
    RTS

; --------------------------------------------------------------------------
; PCM staging -- DISABLED, kept for reference (see PCM_ARM_PRE / PCM_PRE_STEP).
;
; History: the sample used to be read in 2 KB windows, and the window after the
; one being fed was staged into a second buffer ahead of time, in 1024-byte
; halves, so the ~1.5-frame disk burst never landed while the FIFO was empty.
; That is what made two buffers necessary.
;
; It is now off for a simpler reason: one 4 KB window ($4400-$53FF) holds a
; whole drum sample (Crockett's is 2667 B), so a trigger needs a single read,
; and PCM_FILL_WINDOW's window cache makes every repeat of that same sample
; free. The win was measured, not assumed: dropped ticks on Crockett fell
; 10.44 % -> 5.67 % (6-slot ring) -> 2.22 % (4 KB window) -> 0.18 % (cache),
; and the prefetch staged nothing at all in that build (ARM count 0), so it
; was removed from the path rather than kept half-working.
;
; PCM_ARM_PRE and PCM_PRE_STEP return immediately; PCM_WIN stays 0, so the
; feeder always reads PCM_BUFFER and PF_REFILL always takes the synchronous
; path. PCM_BUFFER2 is unused.
; --------------------------------------------------------------------------

; PCM_WIN_PTR — point PCM_PTR at the start of staging buffer PCM_WIN.
PCM_WIN_PTR:
    LDA #<PCM_BUFFER
    STA PCM_PTR_L
    LDA #>PCM_BUFFER
    STA PCM_PTR_H
    LDA PCM_WIN
    BEQ PWP_RTS
    LDA #<PCM_BUFFER2
    STA PCM_PTR_L
    LDA #>PCM_BUFFER2
    STA PCM_PTR_H
PWP_RTS:
    RTS

; PCM_ARM_PRE — queue the window that follows the one being fed. PRE_POS is
; PCM_LOAD; PRE_LEFT is capped at one window (PCM_BUFFER_SIZE).
PCM_ARM_PRE:
    RTS                      ; prefetch disabled (single 4 KB window)
    LDA PCM_PRE
    BEQ PAA_CONT             ; one is already queued
    RTS
PAA_CONT:
    LDA PCM_LOAD_L
    STA PCM_PRE_POS_L
    LDA PCM_LOAD_M
    STA PCM_PRE_POS_M
    LDA PCM_LOAD_H
    STA PCM_PRE_POS_H
    LDA PCM_LEN_L
    SEC
    SBC PCM_LOAD_L
    STA PCM_PRE_LEFT_L
    LDA PCM_LEN_M
    SBC PCM_LOAD_M
    STA PCM_PRE_LEFT_M
    LDA PCM_LEN_H
    SBC PCM_LOAD_H
    BCC PAA_LOOPW            ; past the end of the sample
    ORA PCM_PRE_LEFT_L
    ORA PCM_PRE_LEFT_M
    BEQ PAA_LOOPW            ; exactly at the end of the sample
    BNE PAA_FULL             ; >= 64 KB left, so a full window
    LDA PCM_PRE_LEFT_M
    CMP #>PCM_BUFFER_SIZE
    BCS PAA_FULL
    JMP PAA_ARM              ; short tail: stage exactly what is left
PAA_FULL:
    LDA #$00
    STA PCM_PRE_LEFT_L
    LDA #>PCM_BUFFER_SIZE
    STA PCM_PRE_LEFT_M
    JMP PAA_ARM
PAA_LOOPW:
    ; The window that follows the sample's last one starts at the loop point.
    LDA PCM_LOOPED
    BEQ PAA_RTS_NONE
    LDA PCM_LOOP_L
    STA PCM_PRE_POS_L
    LDA PCM_LOOP_M
    STA PCM_PRE_POS_M
    LDA PCM_LOOP_H
    STA PCM_PRE_POS_H
    LDA PCM_LEN_L
    SEC
    SBC PCM_LOOP_L
    STA PCM_PRE_LEFT_L
    LDA PCM_LEN_M
    SBC PCM_LOOP_M
    STA PCM_PRE_LEFT_M
    LDA PCM_LEN_H
    SBC PCM_LOOP_H
    BCC PAA_RTS_NONE         ; loop point past the end: nothing to stage
    ORA PCM_PRE_LEFT_L
    ORA PCM_PRE_LEFT_M
    BEQ PAA_RTS_NONE
    BNE PAA_FULL
    LDA PCM_PRE_LEFT_M
    CMP #>PCM_BUFFER_SIZE
    BCS PAA_FULL
    JMP PAA_ARM
PAA_RTS_NONE:
    RTS
PAA_ARM:
    LDA PCM_PRE_LEFT_L
    ORA PCM_PRE_LEFT_M
    BNE PAA_ARM_GO
    RTS
PAA_ARM_GO:
    LDA #$00
    STA PCM_PRE_LEN_L
    STA PCM_PRE_LEN_M
    LDA #$01
    STA PCM_PRE
    RTS

; PCM_PRE_STEP — stage up to 1024 bytes of the queued window into the spare
; buffer. A READ failure or a short read ends the sample the same way a
; synchronous window read does: the drums stop, the music keeps playing.
PCM_PRE_STEP:
    RTS                      ; prefetch disabled
    LDA PCM_PRE
    BNE PPS_GO
    RTS
PPS_GO:
    LDA PCM_PRE_LEFT_L
    ORA PCM_PRE_LEFT_M
    BNE PPS_BUSY
    RTS
PPS_BUSY:
    LDA #$00
    STA PCM_IOERR
    ; chunk = min(PRE_LEFT, 1024)
    LDA PCM_PRE_LEFT_M
    CMP #$04
    BCS PPS_CHUNK_BIG
    LDA PCM_PRE_LEFT_L
    STA PCM_COUNT_L
    LDA PCM_PRE_LEFT_M
    STA PCM_COUNT_M
    JMP PPS_DEST
PPS_CHUNK_BIG:
    LDA #$00
    STA PCM_COUNT_L
    LDA #$04
    STA PCM_COUNT_M
PPS_DEST:
    LDA #$00
    STA PCM_COUNT_H
    ; dest = buffer(1-PCM_WIN) + PRE_LEN
    LDA PCM_PRE_LEN_L
    CLC
    ADC #<PCM_BUFFER
    STA READ_PARAMS+2
    LDA PCM_PRE_LEN_M
    ADC #>PCM_BUFFER
    STA READ_PARAMS+3
    LDA PCM_WIN
    BEQ PPS_MARK
    LDA READ_PARAMS+3
    CLC
    ADC #$08                 ; PCM_BUFFER2 = PCM_BUFFER + $800
    STA READ_PARAMS+3
PPS_MARK:
    LDA PCM_REF
    STA SETMARK_PARAMS+1
    LDA PCM_FILE_OFF_L
    CLC
    ADC PCM_PRE_POS_L
    STA SETMARK_PARAMS+2
    LDA PCM_FILE_OFF_M
    ADC PCM_PRE_POS_M
    STA SETMARK_PARAMS+3
    LDA PCM_FILE_OFF_H
    ADC PCM_PRE_POS_H
    STA SETMARK_PARAMS+4
    JSR MLI
    !byte $CE
    !word SETMARK_PARAMS
    BCC PPS_READ
    JMP PPS_FAIL
PPS_READ:
    LDA PCM_REF
    STA READ_PARAMS+1
    LDA PCM_COUNT_L
    STA READ_PARAMS+4
    LDA PCM_COUNT_M
    STA READ_PARAMS+5
    JSR MLI
    !byte $CA
    !word READ_PARAMS
    BCC PPS_OK
    CMP #$4C
    BEQ PPS_EOF
    JMP PPS_FAIL
PPS_EOF:
    ; ProDOS answered a short/zero transfer: the sample is exhausted.
PPS_OK:
    LDA READ_PARAMS+7
    BNE PPS_CNT16
    LDA READ_PARAMS+6
    BEQ PPS_EOF2
    STA PPS_CNT_L
    LDA #$00
    STA PPS_CNT_M
    JMP PPS_ADV
PPS_CNT16:
    LDA READ_PARAMS+6
    STA PPS_CNT_L
    LDA READ_PARAMS+7
    STA PPS_CNT_M
PPS_ADV:
    LDA PCM_PRE_LEN_L        ; PRE_LEN += staged
    CLC
    ADC PPS_CNT_L
    STA PCM_PRE_LEN_L
    LDA PCM_PRE_LEN_M
    ADC PPS_CNT_M
    STA PCM_PRE_LEN_M
    LDA PCM_PRE_POS_L        ; PRE_POS += staged
    CLC
    ADC PPS_CNT_L
    STA PCM_PRE_POS_L
    LDA PCM_PRE_POS_M
    ADC PPS_CNT_M
    STA PCM_PRE_POS_M
    LDA PCM_PRE_POS_H
    ADC #$00
    STA PCM_PRE_POS_H
    LDA PCM_PRE_LEFT_L       ; PRE_LEFT -= staged
    SEC
    SBC PPS_CNT_L
    STA PCM_PRE_LEFT_L
    LDA PCM_PRE_LEFT_M
    SBC PPS_CNT_M
    STA PCM_PRE_LEFT_M
    BCS PPS_RTS
    LDA #$00                 ; over-read (end of sample): clamp
    STA PCM_PRE_LEFT_L
    STA PCM_PRE_LEFT_M
    RTS
PPS_EOF2:
    ; The sample ends inside this window: stage what is there and stop asking.
    LDA #$00
    STA PCM_PRE_LEFT_L
    STA PCM_PRE_LEFT_M
PPS_RTS:
    RTS
PPS_FAIL:
    LDA #$00
    STA PCM_PRE
    LDA #$01
    STA PCM_IOERR
    STA PCM_ACTIVE
    RTS

; PCM_PREFILL — queue about a quarter of the 4 KB FIFO before the sample clock
; starts (8 x 128 = 1 KB, ~0.125 s at 8 kHz), the way pcmstream.asm's
; PREFILL_FIFO primes the FIFO: a stream that starts from an empty FIFO
; underruns on its very first blocks. Filling the whole 4 KB here costs ~4096
; pushes (~5.6 video frames on a 1 MHz //e) and Crockett hits a drum about once
; a second, which was the largest single source of dropped music ticks; 1 KB is
; already 8x the margin PCM_FEED's per-frame top-up needs, and the remainder
; fills up on its own within a few frames.
; PCM_FEED only touches A/Y, so X is a safe counter across the calls.
PCM_PREFILL:
    LDX #$08
PPF_LOOP:
    JSR PCM_FEED
    LDA VERA_AUDIO_CTRL
    BMI PPF_DONE              ; full
    LDA PCM_ACTIVE
    BEQ PPF_DONE
    DEX
    BNE PPF_LOOP
PPF_DONE:
    RTS

; PCM_DRAIN — natural end only: let the queued audio play out before silencing
; (pcmstream.asm's DRAIN_FIFO). A keypress cuts the tail and exits.
PCM_DRAIN:
    LDX #$FF
    LDY #$40                  ; ~1 s fallback, as in pcmstream
PD_LOOP:
    LDA VERA_AUDIO_CTRL
    AND #$40
    BNE PD_DONE               ; FIFO empty
    LDA KBD_DATA
    BPL PD_NOKEY
    STA KBD_STROBE
    JMP PD_DONE
PD_NOKEY:
    JSR SHOW_STATUS
    DEX
    BNE PD_LOOP
    DEY
    BNE PD_LOOP
PD_DONE:
    RTS

; PCM_MUTE — silence the sample by zeroing the AudioCtrl volume. Bit 7 stays
; clear on purpose: flushing the FIFO would throw away queued audio and make
; the track resume from the wrong position.
PCM_MUTE:
    LDA PCM_CTRL
    AND #$F0
    STA VERA_AUDIO_CTRL
    RTS

; PCM_KEY_OFF — silence PCM on song end/exit. A bare $80 write is the flush:
; read-modify-writing the hardware ctrl is wrong on the //e because AppleWin's
; ReadPcmCtrl mixes the FIFO status bits into the read (empty = $40, full =
; $80). With an empty FIFO the read-back $xx|$40 ORA'd with $80 became
; $xx|$C0, AppleWin's WritePcmCtrl read that as (value&0xC0)==0xC0 = "loop
; mode" instead of a flush and additionally ran fifoRestart() -- the leftover
; FIFO bytes then looped forever, which is exactly the ESC residual audio.
PCM_KEY_OFF:
    LDA #$00
    STA PCM_ACTIVE
    LDA #$80
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
    JSR PCM_DRAIN
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
    JSR RESTORE_ZP
    RTS                   ; back to BASIC.SYSTEM (BRUN entry)

DO_MUTE:
    SEI
    LDA MUTE
    BNE DO_UNMUTE
    LDA #$01
    STA MUTE
    JSR SILENCE_ALL
    JSR PCM_MUTE
    JSR FM_KEY_OFF        ; M mutes the FM half too; without it the chip
    CLI                   ; keeps the last chord ringing through a mute
    JMP MAIN
DO_UNMUTE:
    LDA PAUSE             ; unmuting a paused song stays silent until P
    BNE DU_STAY_SILENT
    JSR RESTORE_ALL
    JSR PCM_WRITE_CTRL
    JSR FM_KEYS_RESTORE
DU_STAY_SILENT:
    LDA #$00
    STA MUTE
    CLI
    JMP MAIN

DO_PAUSE:
    LDA PAUSE
    BNE DO_RESUME
    JSR PAUSE_ENTER
    JMP MAIN
DO_RESUME:
    JSR PAUSE_EXIT
    JMP MAIN

; PAUSE_ENTER — freeze the clock and cut the sound. Without the cut the
; IRQ simply stops applying frames, so the PSG oscillators keep running and
; the FM envelopes sit at their sustain level: the paused screen hums the
; last chord until P is pressed again. Silence is written once, here, not
; per frame.
PAUSE_ENTER:
    SEI                   ; the VSYNC handler must not apply a frame between
    LDA #$01              ; the flag and the silence writes
    STA PAUSE
    ; pcmstream.asm freezes a PCM stream by zeroing AudioRate; the same trick
    ; holds the FIFO's queued audio in place so P resumes mid-sample. The
    ; volume mute on top of it is what makes the pause silent -- a frozen
    ; FIFO would otherwise hold its last sample on the wire.
    LDA #$00
    STA VERA_AUDIO_RATE
    JSR SILENCE_ALL       ; PSG: all 64 voice registers to 0
    JSR PCM_MUTE          ; PCM: volume 0, queue kept
    JSR FM_KEY_OFF        ; FM: release all eight channels
    CLI
    RTS

; PAUSE_EXIT — put back what PAUSE_ENTER cut. The PSG is restored from
; PSG_SHADOW (the decoder's own register image, volume-scaled), the PCM
; volume from PCM_CTRL, and the FM keys from FM_KEYS; while MUTE is set the
; PSG/PCM halves stay silent so an M+P+? sequence cannot unmute by accident.
PAUSE_EXIT:
    SEI
    LDA #$00
    STA PAUSE
    LDA PCM_RATE
    STA VERA_AUDIO_RATE
    LDA MUTE
    BNE PE_MUTED
    JSR FM_KEYS_RESTORE
    JSR RESTORE_ALL
    JSR PCM_WRITE_CTRL
PE_MUTED:
    CLI
    RTS

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
; RESTORE_ZP — hand Applesoft's zero page back exactly as we found it.
; Uses A/X only; must not touch $06-$37 before the copy completes.
; --------------------------------------------------------------------------
RESTORE_ZP:
    LDX #$00
RESTORE_ZP_LOOP:
    LDA ZP_SAVE,X
    STA $06,X
    INX
    CPX #$32
    BNE RESTORE_ZP_LOOP
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
; TICK — one VSYNC: consume the oldest frame in the publish ring.
; The decoder has already normalized the ZSM tick rate into 60 Hz frames, so
; there is no rate gating here. The stopwatch counts IRQs, not consumed
; frames (see TICK_NOFRAME), so T: stays locked to real time even when the
; decoder is behind.
; --------------------------------------------------------------------------
TICK:
    LDA PAUSE
    BEQ TICK_MCHK
    RTS                       ; paused: hold the ring, the clock and the
                              ; FIFO exactly where P caught them
TICK_MCHK:
    LDA MUTE
    BEQ TICK1
    JMP TICK_HOLD             ; muted: timeline keeps moving
TICK1:
    LDA FB_CNT
    BNE TICK4
    JMP TICK_NOFRAME
TICK4:
    ; The published frame can be longer than 255 bytes (TITLE has a 128-pair
    ; YM frame, GAMEOVER 213), so walk it with a 16-bit pointer: Y wraps at
    ; 256 and carries into FB_RD_H. An 8-bit Y walk wrapped back into the
    ; frame header and replayed it as YM/PSG data (audible noise).
    LDX FB_TAIL
    TXA
    ASL A                 ; slot n high byte = $73 + 2*n
    CLC
    ADC #FB_RING_H0
    STA FB_RD_H
    LDA #$00
    STA FB_RD_L
    LDY #$00
    LDA (FB_RD_L),Y
    CMP #$FF
    BNE TICK_NOT_HOLD      ; long form: the branch reached 129 bytes and the
    JMP TICK_HOLD          ; assembler rejects anything past 127
TICK_NOT_HOLD:
    STA TCNT1
    CMP #$00              ; STA doesn't touch flags: re-test psgCnt itself.
    BEQ TICK_YM           ; (leftover Z from CMP #$FF made psgCnt=0 fall through,
                          ;  underflow TCNT1 to $FF and flood 256 bogus PSG pairs)
TICK_PSG:
    INY
    BNE TICK_PSG_R
    INC FB_RD_H
TICK_PSG_R:
    LDA (FB_RD_L),Y       ; reg
    TAX
    INY
    BNE TICK_PSG_V
    INC FB_RD_H
TICK_PSG_V:
    LDA (FB_RD_L),Y       ; val
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
    BNE TICK_YM_C
    INC FB_RD_H
TICK_YM_C:
    LDA (FB_RD_L),Y       ; ymCnt
    STA TCNT2
    BEQ TICK_APPLY_DONE
TICK_YML:
    INY
    BNE TICK_YML_R
    INC FB_RD_H
TICK_YML_R:
    LDA (FB_RD_L),Y       ; reg
    TAX
    STA YM_SEL
    INY
    BNE TICK_YML_V
    INC FB_RD_H
TICK_YML_V:
    LDA (FB_RD_L),Y       ; val
    STA YM_DATA
    ; $08 is the key register (operator mask | channel). Keep the last byte
    ; written per channel so P and M can re-key exactly what was sounding
    ; instead of guessing -- a made-up mask retriggers channels that were
    ; already released. IRQ_HANDLER saves X/Y, so X is free here.
    CPX #$08
    BNE TICK_YML_ST
    PHA
    AND #$07
    TAX
    PLA
    STA FM_KEYS,X
TICK_YML_ST:
    DEC TCNT2
    BNE TICK_YML
TICK_APPLY_DONE:
    JSR FB_POP
    JMP TICK_CLK
TICK_HOLD:
    ; muted, or a psgCnt=$FF hold frame: consume it without applying anything
    JSR FB_POP
    JMP TICK_CLK
TICK_NOFRAME:
    ; No frame pending: the decoder fell more than FB_MAX frames behind (or a
    ; rate < 60 hold already consumed). The stopwatch still has to advance,
    ; else T: drifts behind the audio.
    JMP TICK_CLK

; FB_POP — IRQ-side ring pop: the frame just applied is no longer needed.
; Runs only in the IRQ, so the main loop's publish (SEI) can never observe a
; half-updated FB_CNT.
FB_POP:
    DEC FB_CNT
    INC FB_TAIL
    LDA FB_TAIL
    CMP #FB_SLOTS
    BCC FB_POP_OK
    LDA #$00              ; wrap 4 -> 0
FB_POP_OK:
    STA FB_TAIL
    RTS
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
    STA OPEN_PARAMS+5     ; slot/drive input (refnum output of the prior OPEN)
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
    ; YM2151 $08: operator bits 6:3 = keys, channel bits 2:0. With no operator
    ; bits set it keys off that channel, so all eight have to be written --
    ; a single $08=$00 write only ever silenced channel 0.
    LDA #$08
    STA YM_SEL
    LDX #$00
FKO_LOOP:
    TXA
    STA YM_DATA
    INX
    CPX #$08
    BNE FKO_LOOP
    RTS

; FM_KEYS_RESTORE — re-key the channels that were sounding when pause/mute
; cut the chip. YM2151 $08 is the only register a key state lives in, and
; FM_KEYS holds the last byte written per channel (0 = released). Pitch,
; timbre and total level stay latched in the chip across the cut, so the
; re-send resumes the same notes rather than a made-up chord.
FM_KEYS_RESTORE:
    LDA #$08
    STA YM_SEL
    LDX #$00
FKR_LOOP:
    LDA FM_KEYS,X
    STA YM_DATA
    INX
    CPX #$08
    BNE FKR_LOOP
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
    LDA PAUSE             ; a volume change while paused would re-open the
    BNE APV_PSG_MUTED     ; PSG the pause just silenced
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
    LDX #$08              ; a song change starts with every FM channel
CS_KEY:                   ; released, so the key shadow has to say so
    DEX
    STA FM_KEYS,X
    BNE CS_KEY
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
; SHOW_INFO — song header: row 0 "MELODIUS  <category>", row 1 title
; with the duration right-aligned, row 2 rule, rows 3-4 keyboard hints
; (jukebox.hdv style: directly under the title). Row 23 is SHOW_STATUS.
; Text rows are interleaved: row N = $0400 + (N & 7)*$80 + (N >> 3)*40,
; so 21 = $06D0, 22 = $0750, 23 = $07D0 (not $0400 + N*40).
; --------------------------------------------------------------------------
SHOW_INFO:
    LDA #$00
    STA $C002
    STA $C004
    STA $C000
    STA $C054
    STA $C00C
    STA $C051
    STA $C052
    STA $C056

    LDY #$00
SI_BRAND:
    LDA INFO_BRAND,Y
    BEQ SI_CAT
    ORA #$80
    STA $0400,Y
    INY
    BNE SI_BRAND
SI_CAT:
    JSR IS_EXTERNAL
    BNE SI_TITLE
    LDY #$00
SI_CAT_L:
    LDA INFO_CAT,Y
    BEQ SI_TITLE
    ORA #$80
    STA $040A,Y
    INY
    CPY #28
    BNE SI_CAT_L
SI_TITLE:
    JSR IS_EXTERNAL
    BNE SI_TITLE_TABLE
    LDA INFO_TITLE
    BEQ SI_TITLE_NAME
    LDA #<INFO_TITLE
    STA NAME_PTR_L
    LDA #>INFO_TITLE
    STA NAME_PTR_H
    JMP SI_TITLE_DRAW
SI_TITLE_NAME:
    ; no title poked by the menu: show the ProDOS name instead
    LDA EXT_NAME
    BEQ SI_DUR
    LDA #<EXT_NAME
    STA NAME_PTR_L
    LDA #>EXT_NAME
    STA NAME_PTR_H
    JMP SI_TITLE_DRAW
SI_TITLE_TABLE:
    ; built-in menu: SONG_TITLES + SONG_NUM*32
    LDA SONG_NUM
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    CLC
    ADC #<SONG_TITLES
    STA NAME_PTR_L
    LDA #>SONG_TITLES
    ADC #$00
    STA NAME_PTR_H
SI_TITLE_DRAW:
    LDY #$00
SI_TITLE_L:
    LDA (NAME_PTR_L),Y
    BEQ SI_DUR
    ORA #$80
    STA $0480,Y
    INY
    CPY #40
    BNE SI_TITLE_L
SI_DUR:
    ; Duration poked by the MELODIUS menu, right-aligned on the title row.
    LDY #$00
    LDA INFO_DUR
    BEQ SI_RULE
SI_DUR_LEN:
    LDA INFO_DUR,Y
    BEQ SI_DUR_GO
    INY
    CPY #16
    BNE SI_DUR_LEN
SI_DUR_GO:
    LDX #39
SI_DUR_W:
    DEY
    BMI SI_RULE
    LDA INFO_DUR,Y
    ORA #$80
    STA $0480,X
    DEX
    BPL SI_DUR_W
SI_RULE:
    LDY #$00
    LDA #$AD              ; '-'
    ORA #$80
SI_RULE_L:
    STA $0500,Y
    INY
    CPY #40
    BNE SI_RULE_L
SI_CTRL1:
    LDY #$00
SI_CTRL1_L:
    LDA INFO_CTRL1,Y
    BEQ SI_CTRL2
    ORA #$80
    STA $0580,Y
    INY
    BNE SI_CTRL1_L
SI_CTRL2:
    LDY #$00
SI_CTRL2_L:
    LDA INFO_CTRL2,Y
    BEQ SI_LOOP_TAG
    ORA #$80
    STA $0600,Y
    INY
    BNE SI_CTRL2_L
SI_LOOP_TAG:
    JSR SHOW_LOOP_TAG
    RTS

; SHOW_LOOP_TAG — overwrite the 3-char mode tag at the end of "L=LOOP:".
SHOW_LOOP_TAG:
    LDA LOOP_EN
    BEQ SLT_OFF
    LDA #$CF              ; 'O'
    STA $0611
    LDA #$CE              ; 'N'
    STA $0612
    LDA #$A0
    STA $0613
    RTS
SLT_OFF:
    LDA #$CF              ; 'O'
    STA $0611
    LDA #$C6              ; 'F'
    STA $0612
    LDA #$C6              ; 'F'
    STA $0613
    RTS

; Z=1 when the caller is the MELODIUS BASIC menu (external-name mode).
IS_EXTERNAL:
    LDA EXT_MAGIC
    CMP #$4D              ; 'M'
    BNE IE_NO
    LDA EXT_MAGIC+1
    CMP #$5A              ; 'Z'
    BNE IE_NO
    LDA #$00
    RTS
IE_NO:
    LDA #$01
    RTS

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
    ; 16-ch meter, or the PCM sample cursor for a pure-PCM track
    LDA PSGMASK_L
    ORA PSGMASK_H
    BNE METER_HAVE
    LDA PCM_TBL_L
    ORA PCM_TBL_M
    ORA PCM_TBL_H
    BNE SS_PCM_LINE
METER_HAVE:
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
    JMP SS_TAIL
SS_PCM_LINE:
    ; " PCM $xxxxxx" - the streaming cursor, so the status line tracks the audio
    LDA #$A0
    STA $07DA
    LDA #$D0              ; 'P'
    STA $07DB
    LDA #$C3              ; 'C'
    STA $07DC
    LDA #$CD              ; 'M'
    STA $07DD
    LDA #$A0
    STA $07DE
    LDA #$A4              ; '$'
    STA $07DF
    LDA PCM_POS_H
    JSR SS_HEX
    STX $07E0
    STA $07E1
    LDA PCM_POS_M
    JSR SS_HEX
    STX $07E2
    STA $07E3
    LDA PCM_POS_L
    JSR SS_HEX
    STX $07E4
    STA $07E5
    LDA #$A0
    STA $07E6
    STA $07E7
    STA $07E8
    STA $07E9
    STA $07EA
    STA $07EB
    STA $07EC
SS_TAIL:
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

; Split A into two screen-code hex digits: X = high nibble, A = low nibble.
SS_HEX:
    PHA
    LSR
    LSR
    LSR
    LSR
    TAY
    LDA HEX_DIGITS,Y
    TAX
    PLA
    AND #$0F
    TAY
    LDA HEX_DIGITS,Y
    RTS
HEX_DIGITS:
    !byte $B0,$B1,$B2,$B3,$B4,$B5,$B6,$B7,$B8,$B9,$C1,$C2,$C3,$C4,$C5,$C6

; --------------------------------------------------------------------------
; Strings
; --------------------------------------------------------------------------
MENU_TITLE:
    ASC "ZSM JUKEBOX R1 FOR APPLE II          "
    !byte 0
INFO_BRAND:
    ASC "MELODIUS  "
    !byte 0
INFO_CTRL1:
    ASC "ESC=EXIT  P=PAUSE  M=MUTE  R=RESTART"
    !byte 0
INFO_CTRL2:
    ASC "+/-=VOL  L=LOOP:     [/]=SEEK 5S"
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

FM_KEYS:              ; last YM2151 $08 byte per channel (0 = released)
    !byte 0,0,0,0,0,0,0,0

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
TICKS_PER_FRM:
    !byte 1              ; whole ZSM ticks folded into one 60 Hz frame
TICK_REM:
    !byte 0              ; leftover tick rate fraction (sixtieths)
TICKS_LEFT:
    !byte 0              ; source ticks still to decode in this frame
FRAME_PUB:
    !byte 0              ; DECODE_ONE_TICK already published the frame
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
EXT_PLAYED:
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
    !byte 2,0,0,0,0
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
PCM_CPOS_L:              ; file position of the window in PCM_BUFFER
    !byte 0
PCM_CPOS_M:
    !byte 0
PCM_CPOS_H:
    !byte $FF            ; $FF = contents unknown (startup, read failure)
PCM_CLEN_L:              ; length of that window
    !byte 0
PCM_CLEN_M:
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
PP_TMPY:
    !byte 0        ; Y saved for the per-pass bookkeeping
PP_PASSES:
    !byte 0        ; passes left in the current PCM_FEED call


PCM_WIN:
    !byte 0        ; staging buffer being fed: 0 = PCM_BUFFER, 1 = PCM_BUFFER2
PCM_PRE:
    !byte 0        ; 1 = the following window is being staged in the other buffer
PCM_LOAD_L:
    !byte 0        ; sample position where the next window starts
PCM_LOAD_M:
    !byte 0
PCM_LOAD_H:
    !byte 0
PCM_PRE_POS_L:
    !byte 0        ; sample position of the window being staged
PCM_PRE_POS_M:
    !byte 0
PCM_PRE_POS_H:
    !byte 0
PCM_PRE_LEFT_L:
    !byte 0        ; bytes still to stage for it
PCM_PRE_LEFT_M:
    !byte 0
PCM_PRE_LEN_L:
    !byte 0        ; bytes already staged (the staged window's length)
PCM_PRE_LEN_M:
    !byte 0
PPS_CNT_L:
    !byte 0        ; bytes returned by the staging read
PPS_CNT_M:
    !byte 0
PCM_POS_L:
    !byte 0
PCM_POS_M:
    !byte 0
PCM_POS_H:
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
PCM_COUNT_L:
    !byte 0
PCM_COUNT_M:
    !byte 0
PCM_COUNT_H:
    !byte 0
PCM_FPOS_L:
    !byte 0
PCM_FPOS_M:
    !byte 0
PCM_FPOS_H:
    !byte 0
PP_LEFT_L:
    !byte 0        ; bytes of the staged window still unfed (16-bit)
PP_LEFT_H:
    !byte 0
ST_DIV:
    !byte 0        ; status redraw divider (display only)
PCM_REF:
    !byte 0
PCM_IOERR:
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
