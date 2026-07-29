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

module.exports = { parseCSV, buildDataforselector, loadDataset };
