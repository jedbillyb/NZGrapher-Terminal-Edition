'use strict';
/*
 * Minimal sixel encoder, so charts render inline in the terminal without
 * depending on libsixel/img2sixel being installed.
 *
 * Sixel encodes six vertical pixels per character. For each band of six rows we
 * emit, per palette colour, a run of characters whose low six bits mark which
 * rows that colour occupies ('$' returns to the start of the band for the next
 * colour, '-' advances to the next band).
 *
 * Supported by foot, xterm -ti vt340, mlterm, WezTerm, Konsole and others.
 */

const ESC = '\x1b';

// ---- colour quantisation (median cut) ----------------------------------
// Charts are mostly flat colour on white, but antialiased text and dots produce
// a long tail of near-duplicates, so a real quantiser is needed rather than a
// fixed palette.
function medianCut(pixels, maxColors) {
	// pixels: Uint8Array RGB triples, already composited onto white
	const counts = new Map();
	for (let i = 0; i < pixels.length; i += 3) {
		const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
		counts.set(key, (counts.get(key) || 0) + 1);
	}

	let boxes = [[...counts.keys()]];
	if (boxes[0].length === 0) return [[255, 255, 255]];

	const channelOf = (c, ch) => (ch === 0 ? (c >> 16) & 255 : ch === 1 ? (c >> 8) & 255 : c & 255);

	// Population of a box, so splitting favours colours that actually cover area.
	// Range alone would spend the whole palette on the antialiasing ramp of text
	// while leaving flat chart colours sharing a single entry.
	const popOf = (box) => {
		let n = 0;
		for (const c of box) n += counts.get(c);
		return n;
	};

	while (boxes.length < maxColors) {
		let target = -1;
		let targetScore = -1;
		let targetRange = 0;
		let targetCh = 0;
		for (let b = 0; b < boxes.length; b++) {
			if (boxes[b].length < 2) continue;
			const pop = popOf(boxes[b]);
			for (let ch = 0; ch < 3; ch++) {
				let lo = 255;
				let hi = 0;
				for (const c of boxes[b]) {
					const v = channelOf(c, ch);
					if (v < lo) lo = v;
					if (v > hi) hi = v;
				}
				const range = hi - lo;
				const score = range * Math.log2(1 + pop);
				if (range > 0 && score > targetScore) {
					targetScore = score; target = b; targetCh = ch; targetRange = range;
				}
			}
		}
		if (target < 0 || targetRange <= 0) break;

		const box = boxes[target];
		box.sort((a, b) => channelOf(a, targetCh) - channelOf(b, targetCh));
		const mid = box.length >> 1;
		boxes.splice(target, 1, box.slice(0, mid), box.slice(mid));
	}

	// average each box, weighted by how often its colours actually occur
	return boxes.filter((b) => b.length).map((box) => {
		let r = 0, g = 0, bl = 0, n = 0;
		for (const c of box) {
			const w = counts.get(c);
			r += ((c >> 16) & 255) * w;
			g += ((c >> 8) & 255) * w;
			bl += (c & 255) * w;
			n += w;
		}
		return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
	});
}

function buildPalette(rgb, maxColors) {
	const palette = medianCut(rgb, maxColors);
	const cache = new Map();
	const lookup = (r, g, b) => {
		const key = (r << 16) | (g << 8) | b;
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		let best = 0;
		let bestD = Infinity;
		for (let i = 0; i < palette.length; i++) {
			const p = palette[i];
			const dr = r - p[0], dg = g - p[1], db = b - p[2];
			const d = dr * dr + dg * dg + db * db;
			if (d < bestD) { bestD = d; best = i; }
		}
		cache.set(key, best);
		return best;
	};
	return { palette, lookup };
}

/**
 * Encode raw RGBA pixel data as a sixel escape sequence.
 * @param {Buffer|Uint8Array} rgba - width*height*4 bytes
 */
function encodeSixel(rgba, width, height, { maxColors = 200, background = [255, 255, 255] } = {}) {
	// composite onto the background so transparency doesn't read as black
	const rgb = new Uint8Array(width * height * 3);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
		const a = rgba[i + 3] / 255;
		rgb[j] = Math.round(rgba[i] * a + background[0] * (1 - a));
		rgb[j + 1] = Math.round(rgba[i + 1] * a + background[1] * (1 - a));
		rgb[j + 2] = Math.round(rgba[i + 2] * a + background[2] * (1 - a));
	}

	const { palette, lookup } = buildPalette(rgb, maxColors);

	// map every pixel to a palette index once
	const idx = new Uint8Array(width * height);
	for (let p = 0; p < width * height; p++) {
		idx[p] = lookup(rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]);
	}

	const out = [];
	out.push(ESC + 'Pq');
	out.push(`"1;1;${width};${height}`);
	palette.forEach(([r, g, b], i) => {
		// sixel colour components are percentages, not 0-255
		out.push(`#${i};2;${Math.round(r * 100 / 255)};${Math.round(g * 100 / 255)};${Math.round(b * 100 / 255)}`);
	});

	const bandCount = Math.ceil(height / 6);
	const used = new Uint8Array(palette.length);
	const bits = new Uint8Array(width);

	for (let band = 0; band < bandCount; band++) {
		const y0 = band * 6;
		const rows = Math.min(6, height - y0);

		// which colours appear anywhere in this band
		used.fill(0);
		for (let dy = 0; dy < rows; dy++) {
			const rowOff = (y0 + dy) * width;
			for (let x = 0; x < width; x++) used[idx[rowOff + x]] = 1;
		}

		let first = true;
		for (let c = 0; c < palette.length; c++) {
			if (!used[c]) continue;
			if (!first) out.push('$'); // back to start of band for the next colour
			first = false;
			out.push('#' + c);

			bits.fill(0);
			for (let dy = 0; dy < rows; dy++) {
				const rowOff = (y0 + dy) * width;
				const bit = 1 << dy;
				for (let x = 0; x < width; x++) if (idx[rowOff + x] === c) bits[x] |= bit;
			}

			// run-length encode along the row
			let runChar = -1;
			let runLen = 0;
			const flush = () => {
				if (runLen === 0) return;
				const ch = String.fromCharCode(0x3f + runChar);
				// !<n> repeat is only shorter than literals beyond 3 characters
				out.push(runLen > 3 ? '!' + runLen + ch : ch.repeat(runLen));
				runLen = 0;
			};
			for (let x = 0; x < width; x++) {
				const v = bits[x];
				if (v === runChar) runLen++;
				else { flush(); runChar = v; runLen = 1; }
			}
			flush();
		}
		out.push('-'); // next band
	}

	out.push(ESC + '\\');
	return out.join('');
}

/**
 * Ask the terminal for its cell size in pixels (CSI 16 t) and window size
 * (CSI 14 t) so images can be fitted to the window. Resolves to null when the
 * terminal doesn't answer, in which case callers should fall back to an estimate.
 */
function queryTerminalPixels(timeoutMs = 120) {
	return new Promise((resolve) => {
		const { stdin, stdout } = process;
		if (!stdout.isTTY || !stdin.isTTY || typeof stdin.setRawMode !== 'function') {
			return resolve(null);
		}
		let buf = '';
		let done = false;
		const finish = (val) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			stdin.removeListener('data', onData);
			try { stdin.setRawMode(false); } catch { /* ignore */ }
			stdin.pause();
			resolve(val);
		};
		const onData = (d) => {
			buf += d.toString('latin1');
			// response: ESC [ 4 ; height ; width t
			const m = /\x1b\[4;(\d+);(\d+)t/.exec(buf);
			if (m) finish({ height: Number(m[1]), width: Number(m[2]) });
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		try {
			stdin.setRawMode(true);
			stdin.resume();
			stdin.on('data', onData);
			stdout.write(ESC + '[14t');
		} catch {
			finish(null);
		}
	});
}

module.exports = { encodeSixel, queryTerminalPixels };
