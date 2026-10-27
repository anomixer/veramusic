// Create a single-entry deflated ZIP without external dependencies (Node 18+).
// AI-assisted implementation, 2026-10-27.
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

function crc32(data) {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export function writeSingleFileZip(imagePath) {
	const data = fs.readFileSync(imagePath);
	const name = Buffer.from(path.basename(imagePath), "utf8");
	const compressed = deflateRawSync(data, { level: 6 });
	const checksum = crc32(data);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(0x0800, 6); // UTF-8 filename
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(checksum, 14);
	local.writeUInt32LE(compressed.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0x0800, 8); // UTF-8 filename
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(checksum, 16);
	central.writeUInt32LE(compressed.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(name.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(local.length + name.length + compressed.length, 16);
	fs.writeFileSync(`${imagePath}.zip`, Buffer.concat([local, name, compressed, central, name, end]));
}
