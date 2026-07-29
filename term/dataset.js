'use strict';
/*
 * CSV -> `dataforselector`, the column-name -> values map that every graph
 * function in js.js reads from.
 *
 * Upstream builds this by scraping the on-page data table (updatebox()); here it
 * is built directly from the file, which skips the DOM entirely.
 */
const fs = require('fs');

// RFC4180-ish: handles quoted fields, embedded commas/newlines, and "" escapes.
function parseCSV(text) {
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;

	// strip BOM
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') { field += '"'; i++; }
				else inQuotes = false;
			} else field += ch;
			continue;
		}
		if (ch === '"') { inQuotes = true; continue; }
		if (ch === ',') { row.push(field); field = ''; continue; }
		if (ch === '\r') continue;
		if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
		field += ch;
	}
	if (field.length || row.length) { row.push(field); rows.push(row); }

	// drop trailing blank lines
	while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
	return rows;
}

function buildDataforselector(rows) {
	if (!rows.length) throw new Error('dataset is empty');
	const header = rows[0].map((h) => h.trim());

	// ' ' is upstream's "no variable selected" sentinel. '' is included too:
	// several optional column selectors (#verticalerrorbars, #horizontalerrorbars)
	// have no options until data is loaded, so their unset value reads back as ''
	// and js.js indexes dataforselector with it unguarded.
	const dfs = { ' ': [], '': [] };
	const columns = [];

	header.forEach((name, col) => {
		if (name === '') return;
		// duplicate headers would silently overwrite; disambiguate instead
		let key = name;
		let n = 2;
		while (Object.prototype.hasOwnProperty.call(dfs, key)) key = name + ' (' + n++ + ')';
		const vals = [];
		for (let r = 1; r < rows.length; r++) {
			vals.push((rows[r][col] === undefined ? '' : String(rows[r][col])).trim());
		}
		dfs[key] = vals;
		columns.push(key);
	});

	return { dataforselector: dfs, columns, rowCount: Math.max(0, rows.length - 1) };
}

function loadDataset(file) {
	const text = fs.readFileSync(file, 'utf8');
	const rows = parseCSV(text);
	return buildDataforselector(rows);
}

// ---- sampling -----------------------------------------------------------
/*
 * Upstream samples by randomly deleting rows from the on-page table until each
 * level of a single chosen column (#sampleon) has the requested count. That is
 * stratified sampling, but only ever on one variable.
 *
 * Because this port builds the dataset directly rather than scraping the table,
 * sampling is a plain data operation here - which means it generalises to any
 * number of stratifying columns (e.g. Species x Gender) and can be seeded for
 * reproducibility, neither of which the web version can do.
 */

// mulberry32 - small, fast, and good enough for drawing samples.
function makeRng(seed) {
	if (seed === undefined || seed === null || seed === '') {
		return Math.random;
	}
	let a = 0;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) a = (a * 31 + s.charCodeAt(i)) >>> 0;
	a = (a + 0x6d2b79f5) >>> 0;
	return function () {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const STRATA_SEP = ' / ';

/**
 * Draw a stratified simple random sample without replacement.
 *
 * @param {object} ds        dataset from loadDataset()
 * @param {string[]} by      columns defining the strata (empty = one stratum)
 * @param {object} opts
 *   n     {number}  rows per stratum
 *   prop  {number}  fraction of each stratum (0-1), proportional allocation
 *   sizes {object}  explicit per-stratum counts, keyed "Tok / M"
 *   seed  {*}       makes the draw reproducible
 * @returns {{dataset: object, strata: Array}}
 */
function stratifiedSample(ds, by = [], opts = {}) {
	const { n, prop, sizes = {}, seed } = opts;
	const rng = makeRng(seed);
	const total = ds.rowCount;

	for (const col of by) {
		if (!Object.prototype.hasOwnProperty.call(ds.dataforselector, col)) {
			throw new Error(`no such column: ${col}`);
		}
	}

	// group row indices by their combination of stratifying values
	const groups = new Map();
	for (let r = 0; r < total; r++) {
		const key = by.length ? by.map((c) => ds.dataforselector[c][r]).join(STRATA_SEP) : 'all';
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(r);
	}

	const keep = [];
	const strata = [];
	for (const [key, rows] of groups) {
		let take;
		if (Object.prototype.hasOwnProperty.call(sizes, key)) take = Number(sizes[key]);
		else if (prop !== undefined) take = Math.round(rows.length * prop);
		else if (n !== undefined) take = Number(n);
		else take = rows.length;

		take = Math.max(0, Math.min(Math.floor(take), rows.length));

		// partial Fisher-Yates: shuffle only as far as needed
		const pool = rows.slice();
		for (let i = 0; i < take; i++) {
			const j = i + Math.floor(rng() * (pool.length - i));
			const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
		}
		const picked = pool.slice(0, take);
		keep.push(...picked);
		strata.push({ key, available: rows.length, sampled: take });
	}

	// keep original file order so the sample reads naturally
	keep.sort((a, b) => a - b);

	const out = { ' ': [], '': [] };
	for (const col of ds.columns) {
		const src = ds.dataforselector[col];
		out[col] = keep.map((r) => src[r]);
	}

	strata.sort((a, b) => a.key.localeCompare(b.key));
	return {
		dataset: { dataforselector: out, columns: ds.columns.slice(), rowCount: keep.length },
		strata,
	};
}

module.exports = { parseCSV, buildDataforselector, loadDataset, stratifiedSample, STRATA_SEP };
