; ==============================================================================
; VERA (Versatile Embedded Retro Adapter) Hardware Definitions for Apple II
; ==============================================================================
;
; Vendored copy of veratest/src/vera.inc so veramus builds self-contained.
; If upstream changes, re-copy from C:\dev\veratest\src\vera.inc.

; Slot base addresses in Apple II Slot I/O / ROM space
; Slot 2: $C200 / Slot 4: $C400 (Default: VERA_BASE defined by assembler)

VERA_ADDR_L   = VERA_BASE + $00  ; VRAM Address [7:0]
VERA_ADDR_M   = VERA_BASE + $01  ; VRAM Address [15:8]
VERA_ADDR_H   = VERA_BASE + $02  ; VRAM Address [19:16] & Stride/Decr
VERA_DATA0    = VERA_BASE + $03  ; Data Port 0 (Auto-increments)
VERA_DATA1    = VERA_BASE + $04  ; Data Port 1
VERA_CTRL     = VERA_BASE + $05  ; Control (Bit 0=Port Select, Bit 7=Reset)
VERA_IEN      = VERA_BASE + $06  ; Interrupt Enable
VERA_ISR      = VERA_BASE + $07  ; Interrupt Status
VERA_IRQ_L    = VERA_BASE + $08  ; Scanline IRQ Target [7:0]
VERA_DC_VID   = VERA_BASE + $09  ; Display Composer Video Control (Bit 3=L1, Bit 2=L0, Bit 0=Sprites)
VERA_DC_HSC   = VERA_BASE + $0A  ; Display Composer H-Scale (128=1.0x, 64=2.0x)
VERA_DC_VSC   = VERA_BASE + $0B  ; Display Composer V-Scale (128=1.0x, 64=2.0x)
VERA_DC_BOR   = VERA_BASE + $0C  ; Border Color Index

; Layer 0 Registers
VERA_L0_CFG   = VERA_BASE + $0D  ; Layer 0 Config & Color Mode
VERA_L0_MAP   = VERA_BASE + $0E  ; Layer 0 Tilemap Base Address
VERA_L0_TIL   = VERA_BASE + $0F  ; Layer 0 Tile/Bitmap Base Address
VERA_L0_HSC_L = VERA_BASE + $10  ; Layer 0 H-Scroll Low
VERA_L0_HSC_H = VERA_BASE + $11  ; Layer 0 H-Scroll High
VERA_L0_VSC_L = VERA_BASE + $12  ; Layer 0 V-Scroll Low
VERA_L0_VSC_H = VERA_BASE + $13  ; Layer 0 V-Scroll High

; Layer 1 Registers
VERA_L1_CFG   = VERA_BASE + $14  ; Layer 1 Config & Color Mode
VERA_L1_MAP   = VERA_BASE + $15  ; Layer 1 Tilemap Base Address
VERA_L1_TIL   = VERA_BASE + $16  ; Layer 1 Tile/Bitmap Base Address
VERA_L1_HSC_L = VERA_BASE + $17  ; Layer 1 H-Scroll Low
VERA_L1_HSC_H = VERA_BASE + $18  ; Layer 1 H-Scroll High
VERA_L1_VSC_L = VERA_BASE + $19  ; Layer 1 V-Scroll Low
VERA_L1_VSC_H = VERA_BASE + $1A  ; Layer 1 V-Scroll High

; Audio PCM Registers
VERA_AUDIO_CTRL = VERA_BASE + $1B  ; PCM Audio Control & Status
VERA_AUDIO_RATE = VERA_BASE + $1C  ; PCM Audio Sample Rate
VERA_AUDIO_DATA = VERA_BASE + $1D  ; PCM Audio FIFO Data Port
VERA_SPI_DATA   = VERA_BASE + $1E  ; SPI Data
VERA_SPI_CTRL   = VERA_BASE + $1F  ; SPI Control

; Apple II Hardware Softswitches
KBD_DATA      = $C000            ; Read Keyboard Data (Bit 7 = Key pressed)
KBD_STROBE    = $C010            ; Clear Keyboard Strobe
