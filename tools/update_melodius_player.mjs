#!/usr/bin/env node
/**
 * update_melodius_player.mjs - rebuild only the Apple //e player inside an
 * existing melodius.hdv, leaving every song and menu untouched.
 *
 * Why this exists: tools/build_melodius.mjs needs the whole Commander X16
 * Melodius collection (it scans every category folder). On a machine that is
 * missing one of those folders the full builder fails, but a player update
 * does not need the collection at all - the image already holds the songs.
 *
 * Usage:
 *   node tools/update_melodius_player.mjs                 # -> melodius.hdv
 *   node tools/update_melodius_player.mjs --out test.hdv  # work on a copy
 *   node tools/update_melodius_player.mjs --image other.hdv
 *
 * What it does, in the same order as the documented workflow:
 *   1. assemble zsmstream.asm for slot 2 and slot 4 with the builder's guards
 *      (branch labels defined, no unresolved $0000 operand, code below $3F00)
 *   2. write src/MELODIUS.BIN + src/MELODIUS4.BIN (the tracked build outputs)
 *   3. copy the image and REPLACEFILE both players with type/aux #062000
 *   4. CHECKVOLUME, assert the catalog line (BIN $2000, new size), extract both
 *      players and compare them byte-for-byte, then write the verified image
 *   5. when updating the original image, rebuild its matching single-entry ZIP
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assembleAsmFile } from "../../veratest/src/asm6502.mjs";
import { writeSingleFileZip } from "./single_file_zip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..");
const srcDir = path.join(rootDir, "src");
const cadius = process.env.CADIUS || path.join(rootDir, "tools", "cadius.exe");
const LOAD = 0x2000;
const CODE_LIMIT = 0x3f00;

const argv = process.argv.slice(2);
const argValue = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const IMAGE = path.resolve(argValue("--image") || path.join(rootDir, "melodius.hdv"));
const OUT = argValue("--out") ? path.resolve(argValue("--out")) : IMAGE;

const fail = (msg) => { console.error(`[FAILED] ${msg}`); process.exit(1); };
const run = (...args) => execFileSync(cadius, args, { encoding: "utf8" });

if (!fs.existsSync(IMAGE)) fail(`image not found: ${IMAGE}`);
if (!fs.existsSync(cadius)) fail(`Cadius not found at ${cadius}; set CADIUS`);

// ---- assemble ---------------------------------------------------------------
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
		if (m && !labels.has(m[2])) fail(`branch to undefined label ${m[2]} in "${line}"`);
	}
};
const codeRegionEnd = (code) => {
	const marker = Array.from("CANYON.ZSM", (ch) => ch.charCodeAt(0));
	for (let i = 0; i + marker.length <= code.length; i++) {
		if (marker.every((b, k) => code[i + k] === b)) return i;
	}
	return code.length;
};
const zeroGuard = (code, slot) => {
	const end = codeRegionEnd(code);
	for (let i = 0; i + 2 < end; i++) {
		if ([0xad, 0x8d, 0xee, 0xce, 0x4c, 0x20].includes(code[i]) && code[i + 1] === 0 && code[i + 2] === 0) {
			fail(`slot ${slot}: $0000 reference at offset ${i} (unresolved label?)`);
		}
	}
};
const playerSource = path.join(srcDir, "zsmstream.asm");
if (!fs.existsSync(playerSource)) fail("src/zsmstream.asm missing");
branchGuard(playerSource);
const buildPlayer = (slot) => {
	const code = assembleAsmFile(srcDir, "zsmstream.asm", slot, LOAD, []);
	if (LOAD + code.length > CODE_LIMIT) fail(`slot ${slot}: code ends $${(LOAD + code.length).toString(16)} > $3f00`);
	zeroGuard(code, slot);
	return code;
};
const player2 = buildPlayer(2);
const player4 = buildPlayer(4);
fs.writeFileSync(path.join(srcDir, "MELODIUS.BIN"), player2);
fs.writeFileSync(path.join(srcDir, "MELODIUS4.BIN"), player4);
console.log(`[1/4] player: ${player2.length} B @ $2000 (ends $${(LOAD + player2.length).toString(16)}), slots 2 + 4`);

// ---- replace inside a copy --------------------------------------------------
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "melodius-player-"));
const workImage = path.join(tempRoot, "melodius.hdv");
const stageDir = path.join(tempRoot, "stage");
fs.mkdirSync(stageDir);
try {
	fs.copyFileSync(IMAGE, workImage);
	const staged = (name, data) => {
		const file = path.join(stageDir, `${name}#062000`);
		fs.writeFileSync(file, data);
		return file;
	};
	run("REPLACEFILE", workImage, "/MELODIUS", staged("MELODIUS.BIN", player2));
	run("REPLACEFILE", workImage, "/MELODIUS", staged("MELODIUS4.BIN", player4));
	console.log("[2/4] REPLACEFILE /MELODIUS/MELODIUS.BIN + MELODIUS4.BIN");

	// ---- verify before installing --------------------------------------------
	const volume = run("CHECKVOLUME", workImage);
	if (/\bdeclared\b|\bError\s*:/im.test(volume)) fail(`Cadius volume errors:\n${volume}`);
	const catalog = run("CATALOG", workImage);
	const line = (name) => catalog.split(/\r?\n/).find((l) => new RegExp(`^\\s*${name}\\s+BIN\\s+\\$2000\\s+${player2.length}\\s`).test(l));
	for (const name of ["MELODIUS.BIN", "MELODIUS4.BIN"]) {
		if (!line(name)) fail(`catalog does not show ${name} as BIN $2000, ${player2.length} B`);
	}
	console.log("[3/4] CHECKVOLUME clean; catalog shows both players as BIN $2000");

	for (const [name, expected] of [["MELODIUS.BIN", player2], ["MELODIUS4.BIN", player4]]) {
		const extractDir = path.join(tempRoot, `extract-${name}`);
		run("EXTRACTFILE", workImage, `/MELODIUS/${name}`, extractDir);
		const extracted = fs.readdirSync(extractDir).map((f) => path.join(extractDir, f))
			.find((f) => path.basename(f).startsWith(name));
		if (!extracted) fail(`EXTRACTFILE produced no ${name}`);
		if (!fs.readFileSync(extracted).equals(expected)) fail(`extracted ${name} differs from the assembled bytes`);
	}
	console.log("[4/4] both extracted players are byte-identical to the assembled binaries");

	fs.writeFileSync(OUT, fs.readFileSync(workImage));
	console.log(`[OK] wrote ${OUT}`);
	if (OUT !== IMAGE) console.log(`     (source image ${IMAGE} was not modified)`);
	else {
		writeSingleFileZip(OUT);
		console.log(`[OK] wrote ${OUT}.zip`);
	}
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
