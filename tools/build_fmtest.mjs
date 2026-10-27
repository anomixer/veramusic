#!/usr/bin/env node
// Assemble the legacy FM test for both VERA slots. AI-assisted implementation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleAsmFile } from "../../veratest/src/asm6502.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
for (const [slot, name] of [[2, "FMTEST.BIN"], [4, "FMTEST4.BIN"]]) {
	const bytes = assembleAsmFile(src, "fmtest.asm", slot, 0x2000);
	const select = 0x80 + slot * 16;
	const contains = (port) => bytes.some((value, i) =>
		value === 0x8d && bytes[i + 1] === port && bytes[i + 2] === 0xc0);
	if (!contains(select) || !contains(select + 1))
		throw new Error(`slot ${slot}: missing YM_SEL/YM_DATA writes`);
	fs.writeFileSync(path.join(src, name), bytes);
	console.log(`${name}: ${bytes.length} bytes; FM $C0${select.toString(16).toUpperCase()}/$C0${(select + 1).toString(16).toUpperCase()}`);
}
