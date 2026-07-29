'use strict';
/*
 * Parses grapher/index.php and emits term/controls.json — the schema of every
 * form control the graphing code reads via $('#id').val() / .prop('checked').
 *
 * Generated rather than hardcoded so that pulling upstream changes into the
 * fork keeps the CLI's option surface in sync automatically.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'grapher', 'index.php'), 'utf8');

// index.php mixes quoted and bare attribute values (e.g. `name=xvals id=xvar`),
// so all three forms have to be handled.
const attrs = (tag) => {
	const out = {};
	const re = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
	let m;
	while ((m = re.exec(tag))) {
		const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
		out[m[1].toLowerCase()] = v;
	}
	return out;
};

const controls = {};

// <input ...> and <textarea ...>
for (const m of html.matchAll(/<(input|textarea)\b[^>]*>/gi)) {
	const a = attrs(m[0]);
	if (!a.id) continue;
	const type = (a.type || 'text').toLowerCase();
	if (type === 'checkbox' || type === 'radio') {
		controls[a.id] = {
			kind: 'checkbox',
			default: /\bchecked\b/i.test(m[0]),
			value: a.value !== undefined ? a.value : 'yes',
		};
	} else {
		controls[a.id] = {
			kind: type === 'number' ? 'number' : 'text',
			default: a.value !== undefined ? a.value : '',
		};
	}
}

// <select ...> ... </select>
// Some selects in index.php are never closed (e.g. #color), which browsers
// tolerate. Stop the body at the next <select> or </select> so an unclosed tag
// cannot swallow the controls that follow it.
for (const m of html.matchAll(/<select\b([^>]*)>((?:(?!<\/?select\b)[\s\S])*)/gi)) {
	const a = attrs('<select ' + m[1] + '>');
	if (!a.id) continue;
	const options = [];
	let selected = null;
	for (const o of m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
		const oa = attrs('<option ' + o[1] + '>');
		const label = o[2].replace(/<[^>]*>/g, '').trim();
		const value = oa.value !== undefined ? oa.value : label;
		options.push({ value, label });
		if (/\bselected\b/i.test(o[1])) selected = value;
	}
	controls[a.id] = {
		kind: 'select',
		options,
		// an unmarked <select> defaults to its first option, matching the browser
		default: selected !== null ? selected : (a.value !== undefined ? a.value : (options[0] ? options[0].value : '')),
	};
}

const out = path.join(__dirname, 'controls.json');
fs.writeFileSync(out, JSON.stringify(controls, null, '\t') + '\n');

const counts = Object.values(controls).reduce((acc, c) => {
	acc[c.kind] = (acc[c.kind] || 0) + 1;
	return acc;
}, {});
console.log('wrote ' + path.relative(ROOT, out) + ': ' + Object.keys(controls).length + ' controls', counts);
