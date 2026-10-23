#!/usr/bin/env node
// One-off (2026-10-22): pull PCM01.PCM / PCM01.ZSM out of melodius.hdv and print
// the PCM table header so we can confirm the rate-21 rewrite landed in the image.
import fs from "node:fs";

const disk = fs.readFileSync("C:/dev/veramusic/melodius.hdv");

// Volume directory at block 2; root-level entries only.
const blk = disk.subarray(2 * 512, 2 * 512 + 512);
let found = 0;
for (let s = 1; s < 13; s++) {
	const eo = 4 + s * 39;
	const storage = blk[eo];
	const len = storage & 0x0f;
	const type = storage >> 4;
	if (!type || !len) continue;
	const name = blk.toString("ascii", eo + 1, eo + 1 + len);
	if (!/^(PCM01\.PCM|PCM01\.ZSM)$/.test(name)) continue;
	const keyPtr = blk[eo + 13] | (blk[eo + 14] << 8);
	const size = blk[eo + 15] | (blk[eo + 16] << 8);
	console.log(`${name}: keyPtr ${keyPtr}, size ${size}`);
	const idx = disk.subarray(keyPtr * 512, keyPtr * 512 + 512);
	let ptr = idx[5] | (idx[6] << 8);
	let i = 7;
	const blocks = [];
	while (ptr && i < 512) {
		const b = idx[i] | (idx[i + 1] << 8);
		if (b) blocks.push(b);
		i += 2;
	}
	console.log(`  tree index: ${blocks.length} data blocks, first ${blocks[0] ?? "?"}`);
	if (blocks.length) {
		const d0 = disk.subarray(blocks[0] * 512, blocks[0] * 512 + 512);
		console.log(`  bytes 0..23: ${Array.from(d0.subarray(0, 24)).map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
	}
	found++;
}
if (!found) console.log("no PCM01 entries found");