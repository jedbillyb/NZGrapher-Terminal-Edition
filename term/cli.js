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
      --seed <v>            reproducible draw
      --show-sample         print the strata table to stderr

      --list-types      list graph types
      --list-columns    list columns in the dataset
      --list-datasets   list the bundled datasets
      --list-options    list every control --set/--on/--off accepts
  -v, --verbose         let upstream's debug logging through

Graph types accept short names: 'dotplot' == 'newdotplot'.
Datasets resolve from the bundled set by name, e.g. 'Cars'.

examples:
  nzgrapher Cars -x Price
  nzgrapher Cars -t scatter -x Weight -y Horsepower --on regression
  nzgrapher Cars -t rerandmedian -x Price -y origin --out rr.png
`;
}

function parseArgs(argv) {
	const opts = {
		set: {}, on: [], off: [], scale: 2, verbose: false,
	};
	const positional = [];
	const needsValue = new Set([
		'-t', '--type', '-x', '--x', '-y', '--y', '-z', '--z', '-c', '--color',
		'-W', '--width', '-H', '--height', '-s', '--scale', '-o', '--out',
		'--set', '--on', '--off',
		'--sample-by', '--sample-n', '--sample-prop', '--sample-size', '--seed',
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
				case '--on': opts.on.push(v); break;
				case '--off': opts.off.push(v); break;
				case '--sample-by':
					opts.sampleBy = v.split(',').map((s) => s.trim()).filter(Boolean);
					break;
				case '--sample-n': opts.sampleN = Number(v); break;
				case '--sample-prop': opts.sampleProp = Number(v); break;
				case '--seed': opts.seed = v; break;
				case '--sample-size': {
					opts.sampleSizes = opts.sampleSizes || {};
					// "Tok / M=5,Tok / F=5" - split on the last '=' of each entry so
					// stratum names containing '=' still work
					for (const part of v.split(',')) {
						const eq = part.lastIndexOf('=');
						if (eq < 0) throw new Error(`--sample-size expects name=count, got '${part}'`);
						opts.sampleSizes[part.slice(0, eq).trim()] = Number(part.slice(eq + 1));
					}
					break;
				}
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

// Accept a path, or the name of one of the bundled datasets.
function resolveDataset(name) {
	if (!name) throw new Error('a dataset is required (try --list-datasets)');
	if (fs.existsSync(name) && fs.statSync(name).isFile()) return name;
	for (const cand of [name, name + '.csv']) {
		const p = path.join(DATASET_DIR, cand);
		if (fs.existsSync(p)) return p;
	}
	const avail = listDatasets();
	const hit = avail.find((d) => d.toLowerCase() === String(name).toLowerCase());
	if (hit) return path.join(DATASET_DIR, hit + '.csv');
	throw new Error(`dataset not found: ${name} (try --list-datasets)`);
}

function listDatasets() {
	try {
		return fs.readdirSync(DATASET_DIR)
			.filter((f) => f.toLowerCase().endsWith('.csv'))
			.map((f) => f.replace(/\.csv$/i, ''))
			.sort();
	} catch {
		return [];
	}
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
		for (const d of listDatasets()) process.stdout.write(`  ${d}\n`);
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
		datasetPath = resolveDataset(opts.dataset);
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
			|| opts.sampleProp !== undefined || opts.sampleSizes;
		if (wantsSample) {
			const { dataset: sampled, strata } = stratifiedSample(data, opts.sampleBy || [], {
				n: opts.sampleN,
				prop: opts.sampleProp,
				sizes: opts.sampleSizes || {},
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
		result = render({
			dataset: data,
			type,
			width,
			height,
			scale: opts.out || opts.stdout ? Math.max(opts.scale, 1) : opts.scale,
			vars: { xvar: opts.x, yvar: opts.y, zvar: opts.z, color: opts.color },
			set: opts.set,
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
