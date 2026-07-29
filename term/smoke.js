'use strict';
/*
 * Breadth check: attempt every graph type in the #type list against a bundled
 * dataset and report which render. Crude by design - it binds plausible
 * variables rather than correct ones per type - but it shows how much of the
 * engine the headless shim carries.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { graphTypes } = require('./render.js');

const ROOT = path.join(__dirname, '..');
const dataset = process.argv[2] || path.join(ROOT, 'grapher/datasets/Cars.csv');
const outDir = process.argv[3] || null;

// numeric-first, category-second bindings that suit the majority of types
const vars = { xvar: 'Price', yvar: 'city', zvar: 'Type', color: 'origin' };

if (outDir) fs.mkdirSync(outDir, { recursive: true });

const results = [];
for (const t of graphTypes()) {
	const started = Date.now();
	const out = outDir ? path.join(outDir, t.value + '.png') : '';
	try {
		const bytes = execFileSync(
			process.execPath,
			[path.join(__dirname, 'render-one.js'), dataset, t.value, out, JSON.stringify(vars)],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 },
		);
		results.push({ type: t.value, label: t.label, ok: true, bytes: Number(bytes), ms: Date.now() - started });
	} catch (e) {
		// native panics abort without a JS error, so fall back to stderr/signal
		const stderr = (e.stderr || '').toString().trim().split('\n').filter(Boolean);
		const msg = stderr.find((l) => /Error|panic|assert/i.test(l))
			|| (e.signal ? 'native crash (' + e.signal + ')' : 'exit ' + e.status);
		results.push({ type: t.value, label: t.label, ok: false, err: msg.slice(0, 90), ms: Date.now() - started });
	}
}

const ok = results.filter((r) => r.ok);
for (const r of results) {
	const status = r.ok ? 'ok  ' : 'FAIL';
	const detail = r.ok ? `${String(r.bytes).padStart(7)}b ${String(r.ms).padStart(5)}ms` : r.err;
	console.log(`${status} ${r.type.padEnd(30)} ${detail}`);
}
console.log(`\n${ok.length}/${results.length} graph types rendered`);
