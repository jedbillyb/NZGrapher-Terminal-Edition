'use strict';
/*
 * Renders a single graph type to a PNG. Kept as its own entry point so callers
 * (notably term/smoke.js) can isolate each render in a subprocess - an
 * unsupported canvas op can panic the native skia backend and abort the whole
 * process, which would otherwise hide every result after it.
 *
 * usage: node term/render-one.js <dataset.csv> <type> [outfile.png] [varsJSON]
 */
const fs = require('fs');
const { render } = require('./render.js');

const [dataset, type, outfile, varsJSON] = process.argv.slice(2);
if (!dataset || !type) {
	console.error('usage: render-one.js <dataset.csv> <type> [out.png] [varsJSON]');
	process.exit(2);
}

const vars = varsJSON ? JSON.parse(varsJSON) : {};
const r = render({ dataset, type, vars, width: 800, height: 500 });
const png = r.png();
if (outfile) fs.writeFileSync(outfile, png);
process.stdout.write(String(png.length));
