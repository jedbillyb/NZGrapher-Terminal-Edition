'use strict';
/*
 * Drives one graph render end to end.
 *
 * Upstream's updategraph() does three things before dispatching: sets the
 * `scalefactor` global, pushes width/height into the DOM, then calls
 * `window[$('#type').val()]()`. Only the dispatch is reused here; the rest is
 * reproduced directly so no DOM is required.
 */
const { createEnv } = require('./env.js');
const { loadDataset } = require('./dataset.js');
const CONTROLS = require('./controls.json');

// Entries in the #type <select> that open an info page rather than draw a graph.
const NON_GRAPH_TYPES = new Set([
	'newabout', 'newcontributors', 'newlicence', 'newchangelog', 'newupdate',
]);

function graphTypes() {
	const t = CONTROLS.type;
	if (!t || !t.options) return [];
	return t.options
		.filter((o) => o.value && !NON_GRAPH_TYPES.has(o.value))
		.map((o) => ({
			value: o.value,
			// labels carry &nbsp; indentation for the time-series sub-entries
			label: o.label.replace(/&nbsp;/g, '').trim(),
		}));
}

function render(opts) {
	const {
		dataset,
		type = 'newdotplot',
		width = 900,
		height = 600,
		scale = 1,
		vars = {},        // { xvar, yvar, zvar, color }
		set = {},         // arbitrary control id -> value
		check = {},       // arbitrary checkbox id -> bool
		verbose = false,
	} = opts;

	if (!dataset) throw new Error('a dataset is required');

	// Render at `scale` and let the caller downsample; this is how upstream does
	// high-res export (scalefactor 5) and it produces much sharper terminal output.
	const w = Math.round(width * scale);
	const h = Math.round(height * scale);

	const env = createEnv({ width: w, height: h, verbose });
	const ds = typeof dataset === 'string' ? loadDataset(dataset) : dataset;

	env.sandbox.dataforselector = ds.dataforselector;
	env.sandbox.scalefactor = scale;
	env.setValue('scalefactor', String(scale));
	env.setValue('width', String(w));
	env.setValue('height', String(h));
	env.setValue('type', type);

	// Variable bindings. ' ' is upstream's "unset" sentinel.
	for (const key of ['xvar', 'yvar', 'zvar', 'color']) {
		env.setValue(key, vars[key] != null && vars[key] !== '' ? vars[key] : ' ');
	}

	for (const [k, v] of Object.entries(set)) env.setValue(k, v);
	for (const [k, v] of Object.entries(check)) env.setChecked(k, v);

	const fn = env.sandbox[type];
	if (typeof fn !== 'function') {
		throw new Error('unknown graph type: ' + type);
	}

	fn();

	return {
		env,
		canvas: env.canvas,
		png: () => env.canvas.toBuffer('image/png'),
		width: env.canvas.width,
		height: env.canvas.height,
		columns: ds.columns,
	};
}

module.exports = { render, graphTypes, NON_GRAPH_TYPES };
