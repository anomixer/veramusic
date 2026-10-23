#!/usr/bin/env node
/**
 * build_melodius.mjs — MELODIUS jukebox for the Apple II + VERA FM card.
 *
 * Usage:
 *   node tools/build_melodius.mjs
 *   node tools/build_melodius.mjs --src "C:\path\to\MELODIUS"
 *   node tools/build_melodius.mjs --autoplay 0   (temp test HDV, auto-plays song 0)
 *   node tools/build_melodius.mjs --out other.hdv (build elsewhere, e.g. while
 *                                                 melodius.hdv is mounted)
 *
 * Reads the Commander X16 Melodius collection:
 *   <src>/ZSM/Furnace/<artist>/*.zsm
 *   <src>/ZSM/Game Soundtracks/<game>/*.zsm
 *   <src>/PCM/TREE.ZSM
 * (MIDI is excluded: the Apple //e player has no MIDI engine.)
 *
 * Outputs:
 *   src/MELODIUS.BIN / src/MELODIUS4.BIN   player ($2000 BRUN, slot 2 / 4)
 *   src/melodius/*.bas                     generated jukebox BASIC menus
 *   melodius.hdv / .zip                    32MB ProDOS volume, MELODIUS
 *
 * Menu layout (jukebox style, two levels):
 *   STARTUP                      category menu (17 categories)
 *   /MELODIUS/MENUS/<CATEGORY>   song menu for one category
 * Selecting a song POKEs 'M','Z' + the ProDOS name to $6800/$6802, sets the
 * ProDOS prefix to the category folder and BRUNs the player; the player RTSes
 * back to the menu when the song ends or ESC/Q is pressed.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { capZsmPcmSampleRate } from "./zsm_pcm_resample.mjs";
import { fileURLToPath } from "node:url";
import { assembleAsmFile } from "../../veratest/src/asm6502.mjs";
import { compileApplesoftBasic } from "../../veratest/src/applebasic.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..");
const srcDir = path.join(rootDir, "src");
const menuSrcDir = path.join(srcDir, "melodius");
const LOAD = 0x2000;
const CODE_LIMIT = 0x3f00;
const PROGRAM_LIMIT = 0x1700;	// $0801 + len must stay below the $2000 player

const argv = process.argv.slice(2);
const argValue = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const MELODIUS_SRC = path.resolve(
	argValue("--src") || process.env.MELODIUS_DIR ||
	"C:\\dev\\emu\\x16emu\\x16\\SDCARD\\MUSIC\\MELODIUS",
);
const autoplayArg = argValue("--autoplay");
const AUTOPLAY = autoplayArg !== undefined ? Number(autoplayArg) : -1;
const OUT = argValue("--out");

// ---- Category manifest ------------------------------------------------------
// Every ZSM under the Melodius collection, grouped the way the SD card stores
// it. Codes make the ProDOS names short and collision-free (CODE01.ZSM).
const CATEGORIES = [
	{ label: "FURN: BERNIE", dir: "ZSM/Furnace/Bernie", folder: "BERNIE", code: "BEN", kind: "zsm" },
	{ label: "FURN: BURNT FISHY", dir: "ZSM/Furnace/Burnt Fishy", folder: "BURNTFISHY", code: "BNF", kind: "zsm" },
	{ label: "FURN: CRISPS", dir: "ZSM/Furnace/Crisps", folder: "CRISPS", code: "CRP", kind: "zsm" },
	{ label: "FURN: GTR3QQ", dir: "ZSM/Furnace/GTR3QQ", folder: "GTR3QQ", code: "GTR", kind: "zsm" },
	{ label: "FURN: LUNATHIR", dir: "ZSM/Furnace/Lunathir Saelka", folder: "LUNATHIR", code: "LUN", kind: "zsm" },
	{ label: "FURN: MOOINGLEMUR & 0BYTE", dir: "ZSM/Furnace/MooingLemur & ZeroByte", folder: "MOONZERO", code: "MZB", kind: "zsm" },
	{ label: "FURN: MOOINGLEMUR", dir: "ZSM/Furnace/MooingLemur", folder: "MOOINGLEMUR", code: "MOO", kind: "zsm" },
	{ label: "FURN: SNUGGLYBUN", dir: "ZSM/Furnace/SnugglyBun", folder: "SNUGGLYBUN", code: "SNU", kind: "zsm" },
	{ label: "FURN: DUMBUT", dir: "ZSM/Furnace/dumbut", folder: "DUMBUT", code: "DUM", kind: "zsm" },
	{ label: "FURN: NICCO1690", dir: "ZSM/Furnace/nicco1690", folder: "NICCO1690", code: "NIC", kind: "zsm" },
	{ label: "FURN: USERSNIPER", dir: "ZSM/Furnace/usersniper", folder: "USERSNIPER", code: "USR", kind: "zsm" },
	{ label: "GAME: MINE-RESCUE", dir: "ZSM/Game Soundtracks/MINE-RESCUE", folder: "MINERESCUE", code: "MRS", kind: "zsm" },
	{ label: "GAME: MONTEZUMA", dir: "ZSM/Game Soundtracks/Montezuma's Revenge", folder: "MONTEZUMA", code: "MTZ", kind: "zsm" },
	{ label: "GAME: QUARX", dir: "ZSM/Game Soundtracks/QUARX", folder: "QUARX", code: "QRX", kind: "zsm" },
	{ label: "GAME: TETRADS", dir: "ZSM/Game Soundtracks/TETRADS", folder: "TETRADS", code: "TET", kind: "zsm" },
	{ label: "GAME: X16ROBOTS", dir: "ZSM/Game Soundtracks/X16ROBOTS", folder: "X16ROBOTS", code: "XRB", kind: "zsm" },
	{ label: "PCM: TREE", dir: "PCM", folder: "PCM", code: "PCM", kind: "zsm" },
];

const fail = (msg) => { console.error(`[FAILED] ${msg}`); process.exit(1); };
const asciiFold = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// One-pass length in ticks: every $81-$FF command holds for (cmd & $7f)
// frames, $40 carries (ext & $3f) payload bytes, $41-$7F is a YM batch, and
// $80 ends the stream. Mirrors the player's decoder, so the title shows the
// same length the stream will actually play before the loop point.
function zsmDuration(data) {
	let ticks = 0;
	let i = 16;
	while (i < data.length) {
		const cmd = data[i++];
		if (cmd === 0x80) break;
		if (cmd < 0x40) i += 1;		// PSG write: [reg][value]
		else if (cmd === 0x40) {	// EXTCMD: [ext][payload = ext & 0x3f]
			if (i >= data.length) break;
			i += 1 + (data[i] & 0x3f);
		}
		else if (cmd < 0x80) i += (cmd & 0x3f) * 2;	// YM2151 pairs
		else ticks += cmd & 0x7f;
	}
	// Ticks are stream ticks at the file's native rate (header bytes 12-13),
	// which the player normalizes to the 60 Hz output clock. Real seconds are
	// therefore ticks/tickRate, not ticks/60 (Headbanger at 240 Hz runs 4x
	// shorter than a /60 label would claim).
	const rate = (data[12] | (data[13] << 8)) || 60;
	const sec = Math.round(ticks / rate);
	return `(${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")})`;
}

function displayTitle(file) {
	let title = asciiFold(path.basename(file, path.extname(file))).toUpperCase();
	title = title.replace(/[^A-Z0-9 .,!?'()+\-]/g, " ");
	title = title.replace(/,/g, " ").replace(/\s+/g, " ").trim();
	if (!title) title = "TRACK";
	return title.slice(0, 15).padEnd(15, " ");
}

// ---- Scan the music collection ---------------------------------------------
const categories = CATEGORIES.map((cat) => {
	const dir = path.join(MELODIUS_SRC, cat.dir);
	if (!fs.existsSync(dir)) fail(`missing music directory: ${dir}`);
	const sources = fs.readdirSync(dir)
		.filter((name) => /\.zsm$/i.test(name) && fs.statSync(path.join(dir, name)).isFile())
		.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
	if (!sources.length) fail(`no ZSM files in ${dir}`);
	if (sources.length > 17) fail(`${cat.folder}: ${sources.length} songs (max 17 per menu)`);
	if (cat.folder.length > 15) fail(`ProDOS folder name too long: ${cat.folder}`);
	const songs = sources.map((name, index) => {
		const code = `${cat.code}${String(index + 1).padStart(2, "0")}`;
		let buf = fs.readFileSync(path.join(dir, name));
		if (buf.length < 16 || buf.toString("latin1", 0, 2) !== "zm") fail(`not a ZSM file: ${name}`);
		// The //e at 1 MHz still stutters with 16 kHz PCM, so every song is
		// brought down to the jukebox's rate: 8,011 Hz (VERA rate 21), with
		// 16-bit instruments re-quantized to 8-bit. All rate events are scaled
		// by one factor and the data by its inverse, so pitch and duration stay
		// put; mono costs 8 kB/s of FIFO, stereo 16 kB/s.
		const PCM_RATE_MAX = 21; // 8,011 Hz -- jukebox.hdv's RATE_VAL 21
		let resampled = null;
		try {
			resampled = capZsmPcmSampleRate(buf, PCM_RATE_MAX);
		} catch (err) {
			fail(`${name}: ${err.message}`);
		}
		if (resampled) buf = resampled.buffer;
		const pcmTbl = (buf[6] | (buf[7] << 8) | (buf[8] << 16)) >>> 0;
		if (pcmTbl && (pcmTbl <= 16 || pcmTbl > buf.length)) fail(`${name}: bogus pcmTableOffset ${pcmTbl}`);
		const data = pcmTbl ? buf.subarray(0, pcmTbl) : buf;
		return {
			source: path.join(dir, name),
			prodos: `${code}.ZSM`,
			// ProDOS 8 allows one FCB per file, so the sample tail becomes a
			// companion "<code>.PCM" that the player opens next to the stream.
			pcmProdos: pcmTbl ? `${code}.PCM` : null,
			pcmData: pcmTbl ? buf.subarray(pcmTbl) : null,
			resampled,
			title: displayTitle(name),
			duration: zsmDuration(data),
			data,
		};
	});
	return { ...cat, songs };
});

const totalSongs = categories.reduce((n, c) => n + c.songs.length, 0);
if (categories.length > 17) fail("more than 17 menu categories");

if (process.argv.includes("--list")) {
	let n = 0;
	for (const cat of categories)
		for (const song of cat.songs)
			console.log(`${String(n++).padStart(3)} ${song.prodos.padEnd(9)} ${cat.label} / ${path.basename(song.source)}${song.pcmProdos ? " +" + song.pcmProdos : ""}${song.resampled ? ` [PCM rate ${song.resampled.sourceRate}->${song.resampled.targetRate} ${song.resampled.sourceBps}->${song.resampled.targetBps} B/s${song.resampled.depthReduced ? ", 16->8 bit" : ""}]` : ""}`);
	process.exit(0);
}

// ---- Applesoft menu generation ---------------------------------------------
const q = (s) => `"${s.replace(/"/g, "'")}"`;
const screen = (lines) => lines.map(([n, s]) => `${n} ${s}`).join("\n") + "\n";

const slotDetect = [
	[12, "IF S=2 THEN POKE 49673,0"],
	[14, "IF S=4 THEN POKE 50185,0"],
	[15, "HOME"],
	[20, 'PRINT "MELODIUS - A2VERA ZSM JUKEBOX"'],
	[22, 'PRINT "BY ANOMIXER https://github.com/anomixer"'],
	[25, 'PRINT "---------------------------------------"'],
	[28, "IF S>0 THEN GOTO 60"],
	[30, "S=0"],
	[31, "POKE 49669,1"],
	[32, "IF PEEK(49669)=1 THEN GOTO 34"],
	[33, "GOTO 45"],
	[34, "POKE 49669,0"],
	[35, "IF PEEK(49669)=0 THEN GOTO 37"],
	[36, "GOTO 45"],
	[37, "POKE 49664,0"],
	[38, "POKE 49665,0"],
	[39, "POKE 49666,0"],
	[40, "POKE 49667,222"],
	[41, "IF PEEK(49667)=222 THEN GOTO 43"],
	[42, "GOTO 45"],
	[43, "POKE 49667,111"],
	[44, "IF PEEK(49667)=111 THEN S=2"],
	[45, "IF S=2 THEN GOTO 60"],
	[46, "POKE 50181,1"],
	[47, "IF PEEK(50181)=1 THEN GOTO 49"],
	[48, "GOTO 60"],
	[49, "POKE 50181,0"],
	[50, "IF PEEK(50181)=0 THEN GOTO 52"],
	[51, "GOTO 60"],
	[52, "POKE 50176,0"],
	[53, "POKE 50177,0"],
	[54, "POKE 50178,0"],
	[55, "POKE 50179,222"],
	[56, "IF PEEK(50179)=222 THEN GOTO 58"],
	[57, "GOTO 60"],
	[58, "POKE 50179,111"],
	[59, "IF PEEK(50179)=111 THEN S=4"],
	[60, 'IF S=0 THEN PRINT "STATUS: NO VERA CARD DETECTED!"'],
	[62, 'IF S=2 THEN PRINT "STATUS: VERA CARD ON SLOT 2"'],
	[64, 'IF S=4 THEN PRINT "STATUS: VERA CARD ON SLOT 4"'],
];

function dataLines(startLine, items, perLine) {
	const lines = [];
	for (let i = 0; i < items.length; i += perLine) {
		lines.push([startLine + (i / perLine) * 10, `DATA ${items.slice(i, i + perLine).join(",")}`]);
	}
	return lines;
}

function startupSource() {
	const lines = [...slotDetect, [66, "IF S=0 THEN GOTO 90"]];
	lines.push(
		[67, "POKE 26642,S"],
		[68, 'K$="123456789ABCDEFGH"'],
		[70, "RESTORE"],
		[71, "FOR I=0 TO 16"],
		[72, "READ C$,N,M$"],
		[73, 'PRINT MID$(K$,I+1,1);". ";C$;" (";N;")"'],
		[74, "NEXT I"],
		[75, 'PRINT: PRINT "1-9,A-H=SELECT  Q=QUIT"'],
		[80, 'INPUT "SELECT: ";A$'],
		[82, "A$=LEFT$(A$,1)"],
		[84, 'IF A$="Q" THEN GOTO 90'],
		[86, "FOR I=0 TO 16"],
		[87, "IF A$=MID$(K$,I+1,1) THEN GOTO 100"],
		[88, "NEXT I"],
		[89, "GOTO 15"],
		[90, 'PRINT: PRINT "BYE.": END'],
		[100, "RESTORE"],
		[110, "FOR J=0 TO I"],
		[111, "READ C$,N,M$"],
		[112, "NEXT J"],
		[120, 'PRINT CHR$(4);"RUN /MELODIUS/MENUS/";M$'],
		[130, "GOTO 15"],
	);
	const items = [];
	for (const c of categories) items.push(q(c.label), c.songs.length, q(c.folder));
	return screen([...lines, ...dataLines(4000, items, 3)]);
}

function categorySource(cat) {
	const n = cat.songs.length;
	const lines = [
		[10, "TEXT: SPEED=255"],
		[15, 'K$="123456789ABCDEFGH"'],
		[20, "S=PEEK(26642)"],
		[30, "HOME"],
		[40, `PRINT ${q(cat.label)}`],
		[42, `C$=${q(cat.label)}`],
		[45, 'PRINT "---------------------------------------"'],
		[50, 'IF S=2 THEN PRINT "VERA: SLOT 2"'],
		[52, 'IF S=4 THEN PRINT "VERA: SLOT 4"'],
		[55, "PRINT"],
		[58, "RESTORE"],
		[60, `FOR I=1 TO ${n}`],
		[70, "READ S$"],
		[80, 'PRINT MID$(K$,I,1);". ";LEFT$(S$,15)'],
		[90, "NEXT I"],
		[100, 'PRINT: PRINT "RETURN=BACK"'],
		[110, 'INPUT "SELECT: ";A$'],
		[120, "A$=LEFT$(A$,1)"],
		[130, 'IF A$="" THEN PRINT CHR$(4);"RUN /MELODIUS/STARTUP"'],
		[140, `FOR I=1 TO ${n}`],
		[150, "IF A$=MID$(K$,I,1) THEN GOTO 200"],
		[160, "NEXT I"],
		[170, "GOTO 30"],
		[200, "RESTORE"],
		[210, "FOR J=1 TO I"],
		[220, "READ S$"],
		[230, "NEXT J"],
		[240, "F$=MID$(S$,16,9):T$=LEFT$(S$,15):D$=MID$(S$,25)"],
		[242, "FOR J=1 TO LEN(T$): POKE 26647+J, ASC(MID$(T$,J,1)): NEXT J"],
		[244, "POKE 26648+LEN(T$),0"],
		[246, "FOR J=1 TO LEN(C$): POKE 26663+J, ASC(MID$(C$,J,1)): NEXT J"],
		[248, "POKE 26664+LEN(C$),0"],
		[252, "FOR J=1 TO LEN(D$): POKE 26703+J, ASC(MID$(D$,J,1)): NEXT J"],
		[254, "POKE 26704+LEN(D$),0"],
		[250, "POKE 26624,77: POKE 26625,90"],
		[260, "FOR J=1 TO LEN(F$): POKE 26625+J, ASC(MID$(F$,J,1)): NEXT J"],
		[270, "POKE 26626+LEN(F$),0"],
		[280, `PRINT CHR$(4);"PREFIX /MELODIUS/${cat.folder}"`],
		[290, 'IF S=2 THEN PRINT CHR$(4);"BLOAD /MELODIUS/MELODIUS.BIN"'],
		[300, 'IF S=4 THEN PRINT CHR$(4);"BLOAD /MELODIUS/MELODIUS4.BIN"'],
		[303, "CALL 8192"],
		[310, 'PRINT CHR$(4);"PREFIX /MELODIUS"'],
		[320, "GOTO 30"],
	];
	const items = cat.songs.map((s) => q(`${s.title}${s.prodos}${s.duration}`));
	return screen([...lines, ...dataLines(1000, items, 4)]);
}

function autoplaySource(cat, song) {
	const lines = [...slotDetect, [66, "IF S=0 THEN END"]];
	lines.push(
		[67, "POKE 26642,S"],
		[70, "POKE 26624,77: POKE 26625,90"],
		[72, `F$=${q(song.prodos)}:T$=${q(song.title)}:C$=${q(cat.label)}:D$=${q(song.duration)}`],
		[73, "FOR J=1 TO LEN(T$): POKE 26647+J, ASC(MID$(T$,J,1)): NEXT J"],
		[74, "POKE 26648+LEN(T$),0: FOR J=1 TO LEN(C$): POKE 26663+J, ASC(MID$(C$,J,1)): NEXT J"],
		[75, "POKE 26664+LEN(C$),0"],
		[76, "FOR J=1 TO LEN(F$): POKE 26625+J, ASC(MID$(F$,J,1)): NEXT J"],
		[77, "FOR J=1 TO LEN(D$): POKE 26703+J, ASC(MID$(D$,J,1)): NEXT J: POKE 26704+LEN(D$),0"],
		[78, "POKE 26626+LEN(F$),0"],
		[80, `PRINT CHR$(4);"PREFIX /MELODIUS/${cat.folder}"`],
		[90, 'IF S=2 THEN PRINT CHR$(4);"BLOAD /MELODIUS/MELODIUS.BIN"'],
		[100, 'IF S=4 THEN PRINT CHR$(4);"BLOAD /MELODIUS/MELODIUS4.BIN"'],
		[103, "CALL 8192"],
		[105, 'PRINT "BACK TO BASIC"'],
		[110, "END"],
	);
	return screen(lines);
}

// ---- Assemble / compile -----------------------------------------------------
const zsmstreamSource = path.join(srcDir, "zsmstream.asm");
if (!fs.existsSync(zsmstreamSource)) fail("src/zsmstream.asm missing (the player engine)");

const codeRegionEnd = (code) => {
	const marker = Array.from("CANYON.ZSM", (ch) => ch.charCodeAt(0));
	for (let i = 0; i + marker.length <= code.length; i++) {
		if (marker.every((b, k) => code[i + k] === b)) return i;
	}
	return code.length;
};
// asm6502.mjs silently encodes a branch to an undefined label as offset 0
// (fall-through), which once made SHOW_INFO's title loop run past its NUL and
// paint the category text over row 1. Catch it at build time.
const branchGuard = (file) => {
	const text = fs.readFileSync(file, "utf8");
	const labels = new Set();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.split("//")[0].split(";")[0].trim();
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):/);
		if (m) labels.add(m[1]);
	}
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.split("//")[0].split(";")[0].trim();
		const m = line.match(/^(BNE|BEQ|BPL|BMI|BCC|BCS|BVC|BVS)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
		if (m && !labels.has(m[2])) fail(`${path.basename(file)}: branch to undefined label ${m[2]} in "${line}"`);
	}
};
branchGuard(zsmstreamSource);

const zeroGuard = (code, slot) => {
	const end = codeRegionEnd(code);
	for (let i = 0; i + 2 < end; i++) {
		if ([0xad, 0x8d, 0xee, 0xce, 0x4c, 0x20].includes(code[i]) && code[i + 1] === 0 && code[i + 2] === 0) {
			fail(`slot ${slot}: $0000 ref at offset ${i} (unresolved label?)`);
		}
	}
};
const buildPlayer = (slot) => {
	const code = assembleAsmFile(srcDir, "zsmstream.asm", slot, LOAD, []);
	const end = LOAD + code.length;
	if (end > CODE_LIMIT) fail(`slot ${slot}: code ends $${end.toString(16)} > $${CODE_LIMIT.toString(16)}`);
	zeroGuard(code, slot);
	return code;
};

const compileMenu = (file) => {
	const bytes = compileApplesoftBasic(menuSrcDir, path.join(menuSrcDir, file));
	if (0x0801 + bytes.length >= 0x2000) {
		fail(`${file}: BASIC program ends $${(0x0801 + bytes.length).toString(16)} — would be overwritten by the $2000 player`);
	}
	if (bytes.length > PROGRAM_LIMIT) fail(`${file}: BASIC program too large (${bytes.length} bytes)`);
	return bytes;
};

fs.mkdirSync(menuSrcDir, { recursive: true });
let autoplay = null;
if (AUTOPLAY >= 0) {
	if (AUTOPLAY >= totalSongs) fail(`--autoplay ${AUTOPLAY}: only ${totalSongs} songs`);
	let n = AUTOPLAY;
	for (const cat of categories) {
		if (n < cat.songs.length) { autoplay = { cat, song: cat.songs[n] }; break; }
		n -= cat.songs.length;
	}
}

const startupBas = autoplay ? autoplaySource(autoplay.cat, autoplay.song) : startupSource();
fs.writeFileSync(path.join(menuSrcDir, "STARTUP.bas"), startupBas);
for (const cat of categories) {
	fs.writeFileSync(path.join(menuSrcDir, `${cat.folder}.bas`), categorySource(cat));
}

const player2 = buildPlayer(2);
const player4 = buildPlayer(4);
fs.writeFileSync(path.join(srcDir, "MELODIUS.BIN"), player2);
fs.writeFileSync(path.join(srcDir, "MELODIUS4.BIN"), player4);
console.log(`[1/4] player: src/MELODIUS.BIN + MELODIUS4.BIN (${player2.length} B @ $2000, end $${(LOAD + player2.length).toString(16)})`);

const startupCode = compileMenu("STARTUP.bas");
const menuCodes = categories.map((cat) => ({ cat, code: compileMenu(`${cat.folder}.bas`) }));
console.log(`[2/4] menus: STARTUP ${startupCode.length} B + ${menuCodes.length} category programs (${totalSongs} songs)`);

// ---- Cadius ----------------------------------------------------------------
const cadius = process.env.CADIUS || path.join(rootDir, "tools", "cadius.exe");
if (!fs.existsSync(cadius)) fail(`Cadius not found at ${cadius}; set CADIUS`);

const baseHdvPath = path.join(rootDir, "..", "veratest", "assets", "ProDOS 2.4.3.hdv");
if (!fs.existsSync(baseHdvPath)) fail(`missing ProDOS template: ${baseHdvPath}`);
const baseHdv = fs.readFileSync(baseHdvPath);
if (baseHdv.length !== 33553920) fail("bad 32MB ProDOS template size");

const typeNames = new Map([[0x00, "UNK"], [0x06, "BIN"], [0xfc, "BAS"]]);
const runCadius = (...args) => execFileSync(cadius, args, { stdio: "inherit" });
const cadiusText = (...args) => execFileSync(cadius, args, { encoding: "utf8" });

function rootEntries(imagePath) {
	const disk = fs.readFileSync(imagePath);
	const entries = [];
	const visited = new Set();
	let blockNumber = 2;
	while (blockNumber && !visited.has(blockNumber)) {
		visited.add(blockNumber);
		const offset = blockNumber * 512;
		if (offset + 512 > disk.length) fail(`invalid ProDOS directory chain in ${imagePath}`);
		const block = disk.subarray(offset, offset + 512);
		const next = block[2] | (block[3] << 8);
		for (let slot = blockNumber === 2 ? 1 : 0; slot < 13; slot++) {
			const entryOffset = 4 + slot * 39;
			const storageName = block[entryOffset];
			const storageType = storageName >> 4;
			const length = storageName & 0x0f;
			if (!storageType || !length) continue;
			entries.push({
				name: block.toString("ascii", entryOffset + 1, entryOffset + 1 + length),
				isDirectory: storageType === 0x0d,
			});
		}
		blockNumber = next;
	}
	return entries;
}

function clearVolume(imagePath, volumeName) {
	runCadius("RENAMEVOLUME", imagePath, volumeName);
	for (const entry of rootEntries(imagePath)) {
		if (["PRODOS", "BASIC.SYSTEM", "CLOCK.SYSTEM"].includes(entry.name)) continue;
		runCadius(entry.isDirectory ? "DELETEFOLDER" : "DELETEFILE", imagePath, `/${volumeName}/${entry.name}`);
	}
}

function checkVolume(imagePath) {
	const output = cadiusText("CHECKVOLUME", imagePath);
	process.stdout.write(output);
	if (/^\s*=>|\bError\s*:/im.test(output)) fail(`Cadius volume allocation errors for ${imagePath}`);
}

function checkCatalog(imagePath, files) {
	const output = cadiusText("CATALOG", imagePath);
	const lines = output.split(/\r?\n/);
	const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (const f of files) {
		const type = typeNames.get(f.type);
		const aux = f.aux.toString(16).padStart(4, "0");
		const re = new RegExp(`^\\s*${esc(f.name)}\\s+${type}\\s+\\$${aux}\\s+${f.data.length}\\s`);
		if (!lines.some((line) => re.test(line))) {
			fail(`catalog missing ${f.name} (${type} $${aux}, ${f.data.length} B)`);
		}
	}
	return output;
}

function addFiles(imagePath, volumeName, stageDir, files) {
	for (const f of files) {
		const suffix = `#${f.type.toString(16).padStart(2, "0")}${f.aux.toString(16).padStart(4, "0")}`;
		const stageSub = path.join(stageDir, f.folder.replace(/[^A-Za-z0-9]/g, "_"));
		fs.mkdirSync(stageSub, { recursive: true });
		const staged = path.join(stageSub, `${f.name}${suffix}`);
		fs.writeFileSync(staged, f.data);
		runCadius("ADDFILE", imagePath, `/${volumeName}${f.folder === "" ? "" : `/${f.folder}`}`, staged, "--quiet");
	}
}

function buildImage({ imagePath, volumeName, folders, files }) {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "melodius-cadius-"));
	const workImage = path.join(tempRoot, path.basename(imagePath));
	const stageDir = path.join(tempRoot, "stage");
	fs.mkdirSync(stageDir);
	try {
		fs.writeFileSync(workImage, baseHdv);
		clearVolume(workImage, volumeName);
		for (const folder of folders) {
			runCadius("CREATEFOLDER", workImage, `/${volumeName}/${folder}`, "--quiet");
		}
		addFiles(workImage, volumeName, stageDir, files);
		checkVolume(workImage);
		checkCatalog(workImage, files);
		fs.writeFileSync(imagePath, fs.readFileSync(workImage));
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

// ---- File plan --------------------------------------------------------------
const folders = ["MENUS", ...categories.map((c) => c.folder)];
const files = [
	{ folder: "", name: "STARTUP", type: 0xfc, aux: 0x0801, data: startupCode },
	{ folder: "", name: "MELODIUS.BIN", type: 0x06, aux: 0x2000, data: player2 },
	{ folder: "", name: "MELODIUS4.BIN", type: 0x06, aux: 0x2000, data: player4 },
];
for (const { cat, code } of menuCodes) {
	files.push({ folder: "MENUS", name: cat.folder, type: 0xfc, aux: 0x0801, data: code });
}
for (const cat of categories) {
	for (const song of cat.songs) {
		files.push({ folder: cat.folder, name: song.prodos, type: 0x00, aux: 0, data: song.data });
		if (song.pcmProdos) {
			files.push({ folder: cat.folder, name: song.pcmProdos, type: 0x00, aux: 0, data: song.pcmData });
		}
	}
}

const imagePath = OUT
	? path.resolve(OUT)
	: autoplay
		? path.join(os.tmpdir(), "melodius_autoplay.hdv")
		: path.join(rootDir, "melodius.hdv");
buildImage({ imagePath, volumeName: "MELODIUS", folders, files });
console.log(`[3/4] ${imagePath}: ${files.length} files, ${folders.length} folders`);

if (!autoplay) {
	// Lightweight zip (same single-entry format as the jukebox builder).
	const dataBuf = fs.readFileSync(imagePath);
	const zipPath = `${imagePath}.zip`;
	const crc = zlib.crc32(dataBuf);
	const compressed = zlib.deflateRawSync(dataBuf, { level: 6 });
	const nameBuf = Buffer.from(path.basename(imagePath), "utf8");
	const localLen = 30 + nameBuf.length;
	const centralLen = 46 + nameBuf.length;
	const zip = Buffer.alloc(localLen + compressed.length + centralLen + 22);
	let pos = 0;
	zip.writeUInt32LE(0x04034b50, pos); pos += 4;
	zip.writeUInt16LE(20, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt16LE(8, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt32LE(crc, pos); pos += 4;
	zip.writeUInt32LE(compressed.length, pos); pos += 4;
	zip.writeUInt32LE(dataBuf.length, pos); pos += 4;
	zip.writeUInt16LE(nameBuf.length, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	nameBuf.copy(zip, pos); pos += nameBuf.length;
	compressed.copy(zip, pos); pos += compressed.length;
	const centralOffset = localLen + compressed.length;
	zip.writeUInt32LE(0x02014b50, pos); pos += 4;
	zip.writeUInt16LE(20, pos); pos += 2;
	zip.writeUInt16LE(20, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt16LE(8, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt32LE(crc, pos); pos += 4;
	zip.writeUInt32LE(compressed.length, pos); pos += 4;
	zip.writeUInt32LE(dataBuf.length, pos); pos += 4;
	zip.writeUInt16LE(nameBuf.length, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt32LE(0, pos); pos += 4;
	zip.writeUInt32LE(0, pos); pos += 4;
	nameBuf.copy(zip, pos); pos += nameBuf.length;
	zip.writeUInt32LE(0x06054b50, pos); pos += 4;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt16LE(0, pos); pos += 2;
	zip.writeUInt16LE(1, pos); pos += 2;
	zip.writeUInt16LE(1, pos); pos += 2;
	zip.writeUInt32LE(centralLen, pos); pos += 4;
	zip.writeUInt32LE(centralOffset, pos); pos += 4;
	zip.writeUInt16LE(0, pos); pos += 2;
	fs.writeFileSync(zipPath, zip);
	console.log(`[4/4] ${zipPath} (${(zip.length / 1024).toFixed(0)} KB)`);
} else {
	console.log(`[4/4] autoplay test image (song ${AUTOPLAY}: ${autoplay.cat.label} / ${autoplay.song.prodos})`);
}
console.log(`[SUCCESS] MELODIUS jukebox: ${totalSongs} ZSM songs in ${categories.length} categories.`);
