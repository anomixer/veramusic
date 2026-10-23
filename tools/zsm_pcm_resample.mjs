/**
 * Resample the PCM instruments of a ZSM stream down to a lower VERA sample rate.
 *
 * The VERA PCM FIFO drains at rate * 48828.125 / 128 bytes per second, so a
 * 27.8 kHz stream (rate byte 73, like PCM/TREE.ZSM) asks the 6502 to push
 * 27,865 bytes per second through $Cn1D. A //e at its normal 1 MHz cannot keep
 * that up together with the tick decode, so the FIFO underruns and the audio
 * breaks up. Their own jukebox PCM already sidesteps this by running the
 * samples at VERA rate 21 (8 kHz, build_jukebox.mjs RATE_VAL): the same trade,
 * decimate the sample, rewrite the stream's rate event, keep the duration.
 *
 * Sample bytes use the VERA wire formats: mono8 / stereo8 / mono16 / stereo16,
 * 8-bit signed, 16-bit little-endian signed.
 */

const VERA_TICK_HZ = 48828.125 / 128; // bytes/s per VERA rate value
const RATE_MAX = 127; // above 128 VERA uses the 256-rate fast path

export function pcmBytesPerSecond(rateByte) {
	const eff = rateByte > 128 ? 256 - rateByte : rateByte;
	return eff * VERA_TICK_HZ;
}

function readU24(buf, off) {
	return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
}

function writeU24(buf, off, value) {
	buf[off] = value & 0xff;
	buf[off + 1] = (value >> 8) & 0xff;
	buf[off + 2] = (value >> 16) & 0xff;
}

/** Parse the ZSM header and PCM instrument table; null when there is no table. */
export function parseZsmPcm(buf) {
	if (buf.length < 16 || buf.toString('latin1', 0, 2) !== 'zm') return null;
	const pcmTableOffset = readU24(buf, 6);
	if (!pcmTableOffset || pcmTableOffset + 4 > buf.length) return null;
	if (buf.toString('latin1', pcmTableOffset, pcmTableOffset + 3) !== 'PCM') return null;
	const instMax = buf[pcmTableOffset + 3];
	const dataBase = pcmTableOffset + 4 + (instMax + 1) * 16;
	const insts = [];
	for (let i = 0; i <= instMax; i++) {
		const e = pcmTableOffset + 4 + i * 16;
		const geometry = buf[e + 1];
		const format = (geometry >> 4) & 3;
		const length = readU24(buf, e + 5);
		if (!length) continue;
		insts.push({
			index: i,
			e,
			geometry,
			format,
			offset: readU24(buf, e + 2),
			length,
			looped: (buf[e + 8] & 0x80) !== 0,
			loopPoint: readU24(buf, e + 9),
			// bits 4-5 of the geometry byte: 0 mono8, 1 stereo8, 2 mono16,
			// 3 stereo16. A 16-bit sample is two bytes, so mono16 strides by 2
			// and stereo16 by 4 -- the old "stereo ? 2 : 1" made mono16 walk
			// byte-by-byte and turned Crockett's drum into byte hash noise.
			bytesPerFrame: (format & 1 ? 2 : 1) * (format >= 2 ? 2 : 1),
			sampleBytes: format >= 2 ? 2 : 1,
		});
	}
	return { pcmTableOffset, instMax, dataBase, insts };
}

/**
 * Walk the tick stream and return the absolute byte offsets of every PCM rate
 * sub-event (EXTCMD 0x40, ext < 0x40, payload [1, rate]) together with the set
 * of instrument indices that are actually triggered (payload [n>=2, index]).
 */
export function scanPcmEvents(buf, table) {
	const end = table ? table.pcmTableOffset : buf.length;
	const rateEvents = [];
	const triggers = new Set();
	let ptr = 16;
	while (ptr < end) {
		const command = buf[ptr++];
		if (command === 0x80) break; // end of song
		if (command < 0x40) { ptr += 1; continue; } // PSG write: [cmd=reg][val]
		if (command === 0x40) {
			const ext = buf[ptr++];
			if (ext >= 0x40) { ptr += ext & 0x3f; continue; } // external chip batch
			for (let i = 0; i < (ext >> 1); i++) {
				if (buf[ptr] === 1) rateEvents.push(ptr + 1); // [1, rate]
				else if (buf[ptr] >= 2) triggers.add(buf[ptr + 1]); // [n, instrument]
				ptr += 2;
			}
			if (ext & 1) ptr++;
			continue;
		}
		if (command < 0x80) { ptr += 2 * (command & 0x3f); continue; } // YM batch
		// $81-$FF: tick delay, single byte (tick += cmd & 0x7F). The old walk
		// treated it as ZSM 1.1 register/value pairs and misaligned the cursor
		// after the first delay; an intermediate fix advanced ptr again, but
		// `command = buf[ptr++]` already consumed the delay byte, so that
		// second advance skipped the next command byte and hid Crockett's 4
		// rate events behind its 5,605 delay commands. Nothing to add here:
		// ptr is already past the delay byte.
	}
	return { rateEvents, triggers };
}

/** Absolute byte offset of every PCM rate sub-event in the tick stream. */
export function findRateEvents(buf, table) {
	return scanPcmEvents(buf, table).rateEvents;
}

/** Area-averaged decimation of one channel of signed samples. */
function resampleChannel(src, sampleBytes, ratio) {
	if (ratio < 0.999999) throw new Error('upsampling is not supported');
	// Everything below is in units of *samples*, not bytes: read(i) touches
	// bytes sampleBytes*i..sampleBytes*i+sampleBytes-1. Mixing the two made
	// 16-bit decimation emit twice the source length of full-scale noise
	// (Crockett's mono16 drum), while 8-bit songs like TREE stayed correct.
	const nSamples = src.length / sampleBytes;
	const outLen = Math.max(1, Math.floor(nSamples / ratio));
	const read = sampleBytes === 2
		? (i) => src.readInt16LE(i * 2)
		: (i) => src[i] - (src[i] & 0x80 ? 256 : 0);
	const out = Buffer.alloc(outLen * sampleBytes);
	for (let o = 0; o < outLen; o++) {
		const a = o * ratio;
		const b = Math.min((o + 1) * ratio, nSamples);
		if (b <= a) {
			if (sampleBytes === 2) out.writeInt16LE(0, o * 2);
			continue;
		}
		// integrate the linearly interpolated source over [a, b)
		let acc = 0;
		let i = Math.floor(a);
		let pos = a;
		const lastSample = nSamples - 1;
		while (pos < b && i < lastSample) {
			const segEnd = Math.min(b, i + 1);
			const s0 = read(i);
			const s1 = read(i + 1);
			const vEnd = s0 + (s1 - s0) * (segEnd - i);
			acc += ((s0 + vEnd) / 2) * (segEnd - pos);
			pos = segEnd;
			i += 1;
		}
		if (pos < b && i < lastSample + 1) acc += read(i) * (b - pos);
		let v = Math.round(acc / (b - a));
		const limit = sampleBytes === 2 ? 32767 : 127;
		if (v > limit) v = limit;
		if (v < -limit - 1) v = -limit - 1;
		if (sampleBytes === 2) out.writeInt16LE(v, o * 2);
		else out[o] = v & 0xff;
	}
	return out;
}

/** Deterministic TPDF dither in units of one 8-bit LSB, range (-1, 1). */
function makeDither() {
	let s = 0x12345678;
	const rnd = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
	return () => rnd() - rnd();
}

/** Re-quantize one channel of signed 16-bit LE samples to signed 8-bit. */
function to8Bit(ch16) {
	const dither = makeDither();
	const out = Buffer.alloc(ch16.length / 2);
	for (let i = 0; i < out.length; i++) {
		const v = Math.round(ch16.readInt16LE(i * 2) / 256 + dither());
		out[i] = (v < -128 ? -128 : v > 127 ? 127 : v) & 0xff;
	}
	return out;
}

/**
 * Decimate every PCM instrument by `ratio` and rewrite the table entries.
 * Instruments that share the exact same byte range (a sample reused at two
 * pitches, common in Furnace exports) are decimated once and keep sharing it;
 * partially overlapping ranges (a one-byte phase offset twin) each get their
 * own copy, which is why the rebuilt area is not just the old one shrunk.
 *
 * `convertTo8` re-quantizes 16-bit instruments to 8-bit after decimation (area
 * averaging first keeps the full 16-bit resolution, then one dithered
 * rounding), halving both the companion size and the FIFO drain for the same
 * sample rate. Loop points are byte offsets, so they scale with the byte
 * ratio -- including the extra 2x when a sample loses a byte per frame.
 *
 * Returns the new data tail plus the old data length; the caller rewrites the
 * rate bytes and concatenates the untouched prefix.
 */
function shrinkPcmData(buf, table, ratio, convertTo8) {
	const dataLen = buf.length - table.dataBase;
	const parts = [];
	let cursor = 0;
	const written = new Map(); // "offset:length:sampleBytes" -> new location
	for (const inst of table.insts) {
		if (inst.offset + inst.length > dataLen) throw new Error('PCM instrument runs past the end of the stream');
		const conv = convertTo8 && inst.sampleBytes === 2;
		const byteScale = ratio * (conv ? 2 : 1);
		const key = `${inst.offset}:${inst.length}:${inst.sampleBytes}`;
		const done = written.get(key);
		if (done) {
			writeU24(buf, inst.e + 2, done.offset);
			writeU24(buf, inst.e + 5, done.length);
			if (inst.looped) writeU24(buf, inst.e + 9, Math.min(done.length, Math.round(inst.loopPoint / byteScale)));
			continue;
		}
		const channels = inst.bytesPerFrame / inst.sampleBytes;
		const frames = inst.length / inst.bytesPerFrame;
		const outSampleBytes = conv ? 1 : inst.sampleBytes;
		const outFrameBytes = channels * outSampleBytes;
		const channelsOut = [];
		for (let c = 0; c < channels; c++) {
			const channel = Buffer.alloc(frames * inst.sampleBytes);
			for (let f = 0; f < frames; f++)
				for (let s = 0; s < inst.sampleBytes; s++)
					channel[f * inst.sampleBytes + s] = buf[table.dataBase + inst.offset + f * inst.bytesPerFrame + c * inst.sampleBytes + s];
			const decimated = resampleChannel(channel, inst.sampleBytes, ratio);
			channelsOut.push(conv ? to8Bit(decimated) : decimated);
		}
		const data = Buffer.alloc(channelsOut[0].length * channels);
		for (let f = 0; f < data.length / outFrameBytes; f++)
			for (let c = 0; c < channels; c++)
				for (let s = 0; s < outSampleBytes; s++)
					data[f * outFrameBytes + c * outSampleBytes + s] = channelsOut[c][f * outSampleBytes + s];
		if (conv) buf[inst.e + 1] = (inst.geometry & 0xcf) | ((inst.format - 2) << 4);
		writeU24(buf, inst.e + 2, cursor);
		writeU24(buf, inst.e + 5, data.length);
		if (inst.looped) writeU24(buf, inst.e + 9, Math.min(data.length, Math.round(inst.loopPoint / byteScale)));
		written.set(key, { offset: cursor, length: data.length });
		parts.push(data);
		cursor += data.length;
	}
	return { tail: Buffer.concat(parts), dataLen };
}

/**
 * Resample every PCM instrument to `targetRate` (a VERA rate byte) and return a
 * new ZSM buffer: rate events rewritten, instrument offsets/lengths/loop points
 * updated, data area replaced.
 *
 * `normalizeTo` (optional): rewrite every rate event to this byte before the
 * decimation. A Furnace drum pattern switches between adjacent VERA rates
 * (Crockett's drum uses 126 and 128 for the same one-shot), so normalizing to
 * one rate is what lets the single-ratio guard pass. The off-rate segment then
 * plays up to 1.5% slow (~25 cents on a 0.34 s drum hit) -- negligible, and
 * documented in AGENTS.md Milestone 42.
 */
export function resampleZsmPcm(buf, targetRate, normalizeTo) {
	if (!(targetRate >= 1 && targetRate <= RATE_MAX)) throw new Error(`rate ${targetRate} out of the 1..127 range`);
	const table = parseZsmPcm(buf);
	if (!table || !table.insts.length) return null;
	const rateEvents = findRateEvents(buf, table);
	if (!rateEvents.length) throw new Error('PCM table present but the stream sets no PCM rate');
	const rates = new Set(rateEvents.map((off) => buf[off]));
	if (normalizeTo !== undefined) {
		if (!(normalizeTo >= 1 && normalizeTo <= RATE_MAX)) throw new Error(`normalize rate ${normalizeTo} out of the 1..127 range`);
		for (const off of rateEvents) buf[off] = normalizeTo;
		rates.clear();
		rates.add(normalizeTo);
	}
	if (rates.size !== 1) throw new Error(`stream sets several PCM rates: ${[...rates].join(', ')}`);
	const sourceRate = [...rates][0];
	const ratio = pcmBytesPerSecond(sourceRate) / pcmBytesPerSecond(targetRate);
	const { tail, dataLen } = shrinkPcmData(buf, table, ratio);
	for (const off of rateEvents) buf[off] = targetRate;
	return {
		buffer: Buffer.concat([buf.subarray(0, table.dataBase), tail]),
		sourceRate,
		targetRate,
		sourceHz: pcmBytesPerSecond(sourceRate),
		targetHz: pcmBytesPerSecond(targetRate),
		bytes: tail.length,
		saved: dataLen - tail.length,
	};
}

/**
 * Cap the VERA sample rate at `maxRate` (a rate byte; 21 = 8,011 Hz, the
 * jukebox's PCM rate) by scaling *every* rate event by one factor and
 * resampling the instrument data by its inverse. Pitch and duration are
 * preserved because playback rate and sample density move together; only
 * fidelity drops. 16-bit instruments are additionally re-quantized to 8-bit
 * (dithered), which halves their FIFO drain and companion size at that same
 * sample rate.
 *
 * Returns null when the song is already at or below the cap and 8-bit.
 */
export function capZsmPcmSampleRate(buf, maxRate) {
	const table = parseZsmPcm(buf);
	if (!table || !table.insts.length) return null;
	const { rateEvents } = scanPcmEvents(buf, table);
	if (!rateEvents.length) return null;
	const effRate = (r) => (r > 128 ? 256 - r : r);
	const sourceRates = rateEvents.map((off) => effRate(buf[off]));
	const maxSource = Math.max(...sourceRates);
	const depthReduced = table.insts.some((inst) => inst.sampleBytes === 2);
	if (maxSource <= maxRate && !depthReduced) return null;
	const scale = maxSource > maxRate ? maxRate / maxSource : 1;
	// rate 0 stops the FIFO (zsmkit uses it to park the channel) — keep it,
	// otherwise a pause becomes the slowest possible playback
	const newRates = sourceRates.map((r) => {
		if (r === 0) return 0;
		if (scale === 1) return r;
		return Math.max(1, Math.min(RATE_MAX, Math.round(r * scale)));
	});
	const bpfBefore = Math.max(...table.insts.map((inst) => inst.bytesPerFrame));
	const bpfAfter = Math.max(...table.insts.map((inst) => (depthReduced && inst.sampleBytes === 2 ? inst.bytesPerFrame / 2 : inst.bytesPerFrame)));
	const { tail, dataLen } = shrinkPcmData(buf, table, 1 / scale, depthReduced);
	rateEvents.forEach((off, i) => { buf[off] = newRates[i]; });
	const targetRate = Math.max(...newRates);
	return {
		buffer: Buffer.concat([buf.subarray(0, table.dataBase), tail]),
		sourceRate: maxSource,
		targetRate,
		sourceBps: Math.round(maxSource * VERA_TICK_HZ * bpfBefore),
		targetBps: Math.round(targetRate * VERA_TICK_HZ * bpfAfter),
		depthReduced,
		bytes: tail.length,
		saved: dataLen - tail.length,
	};
}
