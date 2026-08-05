#!/usr/bin/env node
'use strict';
/*
 * NZGrapher Terminal Edition - render NZGrapher charts from the terminal.
 *
 * Output routing (all three produce the same pixels, since the drawing is done
 * by upstream's own engine):
 *   default      inline sixel in the terminal
 *   --out FILE   write a PNG
 *   --open       hand the PNG to the system viewer/browser
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const { render, graphTypes } = require('./render.js');
const { loadDataset, stratifiedSample } = require('./dataset.js');
const { encodeSixel, queryTerminalPixels } = require('./sixel.js');
const CONTROLS = require('./controls.json');

const ROOT = path.join(__dirname, '..');
const DATASET_DIR = path.join(ROOT, 'grapher', 'datasets');

function usage() {
	return `NZGrapher Terminal Edition - NZGrapher charts in your terminal

usage: nzgrapher <data.csv> [options]

  -t, --type <name>     graph type (default: dotplot)
  -x, --x <column>      variable 1  (numeric for most graphs)
  -y, --y <column>      variable 2
  -z, --z <column>      variable 3
  -c, --color <column>  colour-by column

  -W, --width <px>      canvas width  (default: fit terminal)
  -H, --height <px>     canvas height (default: 3/5 of width)
  -s, --scale <n>       supersample factor for sharper output (default: 2)

  -o, --out <file.png>  write a PNG instead of drawing inline
      --open            open the chart in your image viewer / browser
      --stdout          write raw PNG bytes to stdout (for piping)

      --set k=v         set any NZGrapher control (repeatable)
      --on  <id>        tick a checkbox option (repeatable)
      --off <id>        untick a checkbox option (repeatable)

 sampling (draw a sample to represent a population):
      --sample-by <cols>    comma-separated strata columns, e.g. Species,Gender
      --sample-n <n>        rows per stratum
      --sample-prop <f>     fraction of each stratum, 0-1 (proportional)
      --sample-size <spec>  explicit counts: "Tok / M=5,Tok / F=5"
      --sample-group-size <spec>
                            fixed target for the FIRST --sample-by column,
                            auto-split proportionally (rounded up) across the
                            rest - no manual per-stratum math needed, e.g.
                            --sample-by Sex,Location --sample-group-size "Male=100,Female=100"
      --seed <v>            reproducible draw
      --show-sample         print the strata table to stderr

      --list-types      list graph types
      --list-columns    list columns in the dataset
      --list-datasets   list the available datasets
      --list-options    list every control --set/--on/--off accepts
  -v, --verbose         let upstream's debug logging through

      --dataset-dir <dir>   look for datasets in this folder too (repeatable)

Graph types accept short names: 'dotplot' == 'newdotplot'.
Datasets resolve from the bundled set by name, e.g. 'Cars', or from any
folder passed via --dataset-dir or the NZGRAPHER_DATASET_DIR environment
variable (colon-separated for multiple folders). A path to a CSV file
always works too.

A dataset may also be an http(s) URL - the CSV is downloaded and cached
locally. A grapher.nz share link like
  https://grapher.nz/?folder=sneddon&dataset=GULLS.csv
is recognised and rewritten to the raw CSV URL automatically.

examples:
  nzgrapher Cars -x Price
  nzgrapher Cars -t scatter -x Weight -y Horsepower --on regression
  nzgrapher Cars -t rerandmedian -x Price -y origin --out rr.png
`;
}

// "Tok / M=5,Tok / F=5" -> {'Tok / M': 5, 'Tok / F': 5}. Splits on the last
// '=' of each entry so stratum names containing '=' still work.
function parseNameCounts(v, flagName) {
	const out = {};
	for (const part of v.split(',')) {
		const eq = part.lastIndexOf('=');
		if (eq < 0) throw new Error(`${flagName} expects name=count, got '${part}'`);
		out[part.slice(0, eq).trim()] = Number(part.slice(eq + 1));
	}
	return out;
}

function parseArgs(argv) {
	const opts = {
		set: {}, on: [], off: [], scale: 2, verbose: false, datasetDirs: [],
	};
	const positional = [];
	const needsValue = new Set([
		'-t', '--type', '-x', '--x', '-y', '--y', '-z', '--z', '-c', '--color',
		'-W', '--width', '-H', '--height', '-s', '--scale', '-o', '--out',
		'--set', '--on', '--off', '--dataset-dir',
		'--sample-by', '--sample-n', '--sample-prop', '--sample-size', '--sample-group-size', '--seed',
	]);

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h' || a === '--help') { opts.help = true; continue; }
		if (a === '--open') { opts.open = true; continue; }
		if (a === '--stdout') { opts.stdout = true; continue; }
		if (a === '-v' || a === '--verbose') { opts.verbose = true; continue; }
		if (a === '--list-types') { opts.listTypes = true; continue; }
		if (a === '--list-columns') { opts.listColumns = true; continue; }
		if (a === '--list-datasets') { opts.listDatasets = true; continue; }
		if (a === '--list-options') { opts.listOptions = true; continue; }
		if (a === '--show-sample') { opts.showSample = true; continue; }

		if (needsValue.has(a)) {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} requires a value`);
			switch (a) {
				case '-t': case '--type': opts.type = v; break;
				case '-x': case '--x': opts.x = v; break;
				case '-y': case '--y': opts.y = v; break;
				case '-z': case '--z': opts.z = v; break;
				case '-c': case '--color': opts.color = v; break;
				case '-W': case '--width': opts.width = Number(v); break;
				case '-H': case '--height': opts.height = Number(v); break;
				case '-s': case '--scale': opts.scale = Number(v); break;
				case '-o': case '--out': opts.out = v; break;
				case '--dataset-dir': opts.datasetDirs.push(v); break;
				case '--on': opts.on.push(v); break;
				case '--off': opts.off.push(v); break;
				case '--sample-by':
					opts.sampleBy = v.split(',').map((s) => s.trim()).filter(Boolean);
					break;
				case '--sample-n': opts.sampleN = Number(v); break;
				case '--sample-prop': opts.sampleProp = Number(v); break;
				case '--seed': opts.seed = v; break;
				case '--sample-size':
					opts.sampleSizes = { ...(opts.sampleSizes || {}), ...parseNameCounts(v, '--sample-size') };
					break;
				case '--sample-group-size':
					opts.sampleGroupSizes = { ...(opts.sampleGroupSizes || {}), ...parseNameCounts(v, '--sample-group-size') };
					break;
				case '--set': {
					const eq = v.indexOf('=');
					if (eq < 0) throw new Error(`--set expects key=value, got '${v}'`);
					opts.set[v.slice(0, eq)] = v.slice(eq + 1);
					break;
				}
			}
			continue;
		}
		if (a.startsWith('-') && a !== '-') throw new Error(`unknown option: ${a}`);
		positional.push(a);
	}
	opts.dataset = positional[0];
	return opts;
}

// 'dotplot' -> 'newdotplot'; also accepts the full upstream name.
function resolveType(name) {
	if (!name) return 'newdotplot';
	const types = graphTypes().map((t) => t.value);
	if (types.includes(name)) return name;
	if (types.includes('new' + name)) return 'new' + name;
	const lower = name.toLowerCase().replace(/[^a-z]/g, '');
	const hit = types.find((t) => t.toLowerCase() === lower || t.toLowerCase() === 'new' + lower);
	if (hit) return hit;
	throw new Error(`unknown graph type '${name}' (try --list-types)`);
}

// A grapher.nz "share link" (folder browser URL) points at the app page, not
// the raw file. The raw CSV for folder=F&dataset=D lives at /F/D directly.
function normalizeDatasetUrl(u) {
	try {
		const parsed = new URL(u);
		if (/(^|\.)grapher\.nz$/i.test(parsed.hostname)) {
			const folder = parsed.searchParams.get('folder');
			const dataset = parsed.searchParams.get('dataset');
			if (folder && dataset) {
				return `${parsed.protocol}//${parsed.hostname}/${folder}/${dataset}`;
			}
		}
	} catch {
		// not a valid URL - fall through unchanged
	}
	return u;
}

function isUrl(s) {
	return /^https?:\/\//i.test(s);
}

// Downloads are cached on disk keyed by URL, so repeated runs against the
// same dataset (e.g. while iterating on a sample) don't re-fetch every time.
function fetchDataset(url) {
	return new Promise((resolve, reject) => {
		const resolved = normalizeDatasetUrl(url);
		const cacheDir = path.join(os.tmpdir(), 'nzgrapher-url-cache');
		fs.mkdirSync(cacheDir, { recursive: true });
		const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 16);
		const base = path.basename(new URL(resolved).pathname) || 'dataset.csv';
		const dest = path.join(cacheDir, `${hash}-${base}`);
		if (fs.existsSync(dest)) return resolve(dest);

		const get = (u, redirectsLeft) => {
			const lib = u.startsWith('https:') ? https : http;
			lib.get(u, (res) => {
				if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
					res.resume();
					if (redirectsLeft <= 0) return reject(new Error(`too many redirects fetching ${url}`));
					return get(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
				}
				if (res.statusCode !== 200) {
					res.resume();
					return reject(new Error(`failed to fetch ${u}: HTTP ${res.statusCode}`));
				}
				const tmp = dest + '.part';
				const out = fs.createWriteStream(tmp);
				res.pipe(out);
				out.on('finish', () => out.close((err) => {
					if (err) return reject(err);
					fs.renameSync(tmp, dest);
					resolve(dest);
				}));
				out.on('error', reject);
			}).on('error', reject);
		};
		get(resolved, 5);
	});
}

// Custom folders take priority (in the order given) over the bundled set,
// so a user's own dataset can shadow a bundled one of the same name.
function datasetDirs(extra) {
	const fromEnv = (process.env.NZGRAPHER_DATASET_DIR || '')
		.split(path.delimiter)
		.map((s) => s.trim())
		.filter(Boolean);
	return [...(extra || []), ...fromEnv, DATASET_DIR];
}

// Accept a path, or the name of one of the bundled/custom datasets.
function resolveDataset(name, dirs) {
	if (!name) throw new Error('a dataset is required (try --list-datasets)');
	if (fs.existsSync(name) && fs.statSync(name).isFile()) return name;
	for (const dir of datasetDirs(dirs)) {
		for (const cand of [name, name + '.csv']) {
			const p = path.join(dir, cand);
			if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
		}
	}
	const avail = listDatasets(dirs);
	const hit = avail.find((d) => d.name.toLowerCase() === String(name).toLowerCase());
	if (hit) return hit.path;
	throw new Error(`dataset not found: ${name} (try --list-datasets)`);
}

// Returns [{ name, path, dir }], de-duplicated by name (first dir wins).
function listDatasets(dirs) {
	const seen = new Set();
	const out = [];
	for (const dir of datasetDirs(dirs)) {
		let files;
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of files.filter((f) => f.toLowerCase().endsWith('.csv')).sort()) {
			const name = f.replace(/\.csv$/i, '');
			if (seen.has(name.toLowerCase())) continue;
			seen.add(name.toLowerCase());
			out.push({ name, path: path.join(dir, f), dir });
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function fitToTerminal(opts) {
	if (opts.width) {
		return { width: opts.width, height: opts.height || Math.round(opts.width * 0.6) };
	}
	let px = null;
	if (!opts.out && !opts.open && !opts.stdout) px = await queryTerminalPixels();

	// leave a small margin so the image doesn't touch the right edge
	let width = px && px.width ? Math.floor(px.width * 0.92) : (process.stdout.columns || 100) * 8;
	width = Math.max(320, Math.min(width, 1600));
	const height = opts.height || Math.round(width * 0.6);
	return { width, height };
}

function openFile(file) {
	const cmd = process.platform === 'darwin' ? 'open'
		: process.platform === 'win32' ? 'start'
		: 'xdg-open';
	const child = spawn(cmd, [file], { stdio: 'ignore', detached: true });
	child.on('error', () => {
		process.stderr.write(`could not launch ${cmd}; the chart is at ${file}\n`);
	});
	child.unref();
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`nzgrapher: ${e.message}\n`);
		process.exit(2);
	}

	if (opts.help || (!opts.dataset && !opts.listTypes && !opts.listDatasets && !opts.listOptions)) {
		process.stdout.write(usage());
		return;
	}

	if (opts.listTypes) {
		for (const t of graphTypes()) {
			process.stdout.write(`  ${t.value.replace(/^new/, '').padEnd(26)} ${t.label}\n`);
		}
		return;
	}

	if (opts.listDatasets) {
		for (const d of listDatasets(opts.datasetDirs)) {
			const from = d.dir === DATASET_DIR ? '' : `  (${d.dir})`;
			process.stdout.write(`  ${d.name}${from}\n`);
		}
		return;
	}

	if (opts.listOptions) {
		for (const [id, c] of Object.entries(CONTROLS).sort(([a], [b]) => a.localeCompare(b))) {
			if (c.kind === 'checkbox') {
				process.stdout.write(`  --on/--off ${id.padEnd(28)} (default ${c.default ? 'on' : 'off'})\n`);
			} else {
				const extra = c.kind === 'select' && c.options.length
					? '  one of: ' + c.options.map((o) => o.value).filter(Boolean).join(', ').slice(0, 90)
					: '';
				process.stdout.write(`  --set ${(id + '=' + c.default).padEnd(32)}${extra}\n`);
			}
		}
		return;
	}

	let datasetPath;
	try {
		datasetPath = isUrl(opts.dataset)
			? await fetchDataset(opts.dataset)
			: resolveDataset(opts.dataset, opts.datasetDirs);
	} catch (e) {
		process.stderr.write(`nzgrapher: ${e.message}\n`);
		process.exit(1);
	}

	if (opts.listColumns) {
		const ds = loadDataset(datasetPath);
		process.stdout.write(`${path.basename(datasetPath)} - ${ds.rowCount} rows\n`);
		for (const c of ds.columns) {
			const vals = ds.dataforselector[c];
			const numeric = vals.filter((v) => v !== '' && !isNaN(Number(v))).length;
			const kind = numeric > vals.length * 0.8 ? 'numeric' : 'categorical';
			process.stdout.write(`  ${c.padEnd(24)} ${kind}\n`);
		}
		return;
	}

	let type;
	try {
		type = resolveType(opts.type);
	} catch (e) {
		process.stderr.write(`nzgrapher: ${e.message}\n`);
		process.exit(1);
	}

	const { width, height } = await fitToTerminal(opts);

	const check = {};
	for (const id of opts.on) check[id] = true;
	for (const id of opts.off) check[id] = false;

	// Draw the sample before rendering, so the graph sees only the sampled rows -
	// the same order of operations as the web version.
	let data;
	try {
		data = loadDataset(datasetPath);
		const wantsSample = opts.sampleBy || opts.sampleN !== undefined
			|| opts.sampleProp !== undefined || opts.sampleSizes || opts.sampleGroupSizes;
		if (wantsSample) {
			const { dataset: sampled, strata } = stratifiedSample(data, opts.sampleBy || [], {
				n: opts.sampleN,
				prop: opts.sampleProp,
				sizes: opts.sampleSizes || {},
				groupSizes: opts.sampleGroupSizes,
				seed: opts.seed,
			});
			if (opts.showSample) {
				const by = (opts.sampleBy || []).join(' x ') || '(whole dataset)';
				process.stderr.write(`sample stratified by ${by}${opts.seed !== undefined ? `, seed ${opts.seed}` : ''}\n`);
				for (const s of strata) {
					process.stderr.write(`  ${s.key.padEnd(24)} ${String(s.sampled).padStart(4)} of ${s.available}\n`);
				}
				process.stderr.write(`  ${'total'.padEnd(24)} ${String(sampled.rowCount).padStart(4)} of ${data.rowCount}\n`);
			}
			data = sampled;
		}
	} catch (e) {
		process.stderr.write(`nzgrapher: ${e.message}\n`);
		process.exit(1);
	}

	let result;
	try {
		// The web UI auto-fills the axis-title/colour-label text boxes with the
		// chosen variable's name when you pick it from the dropdown (see
		// grapher/index.php's onChange handlers on the variable selects) - the
		// render engine itself never does this, so without it the terminal
		// output falls back to the raw "X Axis Title" placeholder. Mirror that
		// behaviour here, but let an explicit --set win if the user gave one.
		const axisDefaults = {};
		if (opts.x && !('xaxis' in opts.set)) axisDefaults.xaxis = opts.x;
		if (opts.y && !('yaxis' in opts.set)) axisDefaults.yaxis = opts.y;
		if (opts.color && !('colorlabel' in opts.set)) axisDefaults.colorlabel = opts.color;

		result = render({
			dataset: data,
			type,
			width,
			height,
			scale: opts.out || opts.stdout ? Math.max(opts.scale, 1) : opts.scale,
			vars: { xvar: opts.x, yvar: opts.y, zvar: opts.z, color: opts.color },
			set: { ...axisDefaults, ...opts.set },
			check,
			verbose: opts.verbose,
		});
	} catch (e) {
		process.stderr.write(`nzgrapher: render failed: ${e.message}\n`);
		process.exit(1);
	}

	const png = result.png();

	if (opts.stdout) { process.stdout.write(png); return; }

	if (opts.out) {
		fs.writeFileSync(opts.out, png);
		process.stderr.write(`wrote ${opts.out} (${result.width}x${result.height})\n`);
		if (opts.open) openFile(path.resolve(opts.out));
		return;
	}

	if (opts.open) {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nzgrapher-')), 'chart.png');
		fs.writeFileSync(file, png);
		openFile(file);
		process.stderr.write(`opened ${file}\n`);
		return;
	}

	// inline: downsample the supersampled canvas to the target size, then encode
	const { createCanvas } = require('@napi-rs/canvas');
	const target = createCanvas(width, height);
	const tctx = target.getContext('2d');
	tctx.fillStyle = '#ffffff';
	tctx.fillRect(0, 0, width, height);
	tctx.drawImage(result.canvas, 0, 0, width, height);
	const pixels = tctx.getImageData(0, 0, width, height).data;

	process.stdout.write(encodeSixel(pixels, width, height) + '\n');
}

main().catch((e) => {
	process.stderr.write(`nzgrapher: ${e.stack || e.message}\n`);
	process.exit(1);
});
