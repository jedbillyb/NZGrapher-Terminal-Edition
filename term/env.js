'use strict';
/*
 * Headless environment for grapher/js.js.
 *
 * js.js is a classic browser script: it expects globals ($, window, document)
 * and reads every graph option out of the DOM via $('#id').val() / .is(':checked').
 * Rather than run a full DOM, this provides a settings-backed jQuery stand-in.
 *
 * Two behaviours are load-bearing and modelled faithfully:
 *
 *  - :checked  -> the option's boolean value.
 *  - :visible  -> whether the option applies to the current graph type. Each
 *                 graph function begins by .show()-ing the wrapper spans of the
 *                 options it supports (e.g. #soliddotsshow wraps #soliddots), and
 *                 later guards read `.is(':checked') && .is(':visible')`. So
 *                 visibility is tracked, and an element inherits it from its
 *                 `<id>show` wrapper when one exists.
 *
 * Everything else (.css, .append, .html, animations, event binding) is a no-op.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const ROOT = path.join(__dirname, '..');
const CONTROLS = require('./controls.json');

/*
 * Every ctx.font string in js.js asks for "Roboto". Rather than vendor a font,
 * the best available sans-serif on the system is registered under that alias so
 * upstream's font strings resolve without touching upstream code. Without this,
 * text renders as tofu boxes.
 */
const FONT_CANDIDATES = [
	'Roboto', 'Open Sans', 'Noto Sans', 'DejaVu Sans', 'Liberation Sans',
	'Nimbus Sans', 'Droid Sans', 'Arial', 'Helvetica',
];

let fontsReady = false;
function ensureFonts() {
	if (fontsReady) return;
	fontsReady = true;

	// Pull in system fonts so the candidates below can be found by family name.
	try { GlobalFonts.loadSystemFonts(); } catch { /* not fatal */ }

	const families = new Set();
	try { for (const f of GlobalFonts.families || []) families.add(f.family); } catch { /* ignore */ }

	if (families.has('Roboto')) return; // upstream's font is genuinely present

	// Locate a concrete font file for the first available candidate and alias it.
	const dirs = ['/usr/share/fonts', '/usr/local/share/fonts', path.join(process.env.HOME || '', '.fonts')];
	const walk = (dir, out = []) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p, out);
			else if (/\.(ttf|otf)$/i.test(e.name)) out.push(p);
		}
		return out;
	};

	const files = dirs.flatMap((d) => walk(d));
	const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
	for (const cand of FONT_CANDIDATES) {
		const want = norm(cand);
		// prefer the plain regular weight over Bold/Italic/Condensed variants
		const match = files
			.filter((f) => norm(path.basename(f, path.extname(f))).startsWith(want))
			.sort((a, b) => a.length - b.length)[0];
		if (match) {
			try {
				GlobalFonts.registerFromPath(match, 'Roboto');
				return;
			} catch { /* try the next candidate */ }
		}
	}
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createEnv(options = {}) {
	ensureFonts();
	const width = Number(options.width) || 900;
	const height = Number(options.height) || 600;

	// ---- settings store -------------------------------------------------
	// Mirrors the ~169 form controls in index.php. Values are kept as strings
	// (as jQuery's .val() returns) so arithmetic in js.js coerces identically.
	const values = new Map();
	const checked = new Map();
	const visible = new Map();

	for (const [id, c] of Object.entries(CONTROLS)) {
		if (c.kind === 'checkbox') checked.set(id, !!c.default);
		else values.set(id, String(c.default == null ? '' : c.default));
	}

	const setValue = (id, v) => values.set(id, v == null ? '' : String(v));
	const setChecked = (id, v) => checked.set(id, !!v);

	setValue('width', String(width));
	setValue('height', String(height));

	// ---- canvas ---------------------------------------------------------
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	// js.js assigns `ctx.canvas.width = $('#width').val()` — a string. Guard the
	// setters so a string dimension doesn't produce a zero-sized surface.
	const rawCanvas = canvas;

	// js.js sets dimensions as strings and reaches the canvas through `ctx.canvas`,
	// so both the canvas and the context are proxied: the canvas coerces
	// width/height to integers, and the context routes `.canvas` back through the
	// proxy rather than handing out the raw object.
	const canvasProxy = new Proxy(rawCanvas, {
		get(t, k) {
			if (k === 'getContext') return () => ctxProxy;
			const v = Reflect.get(t, k);
			return typeof v === 'function' ? v.bind(t) : v;
		},
		set(t, k, v) {
			if (k === 'width' || k === 'height') {
				return Reflect.set(t, k, Math.max(1, Math.round(Number(v) || 0)));
			}
			return Reflect.set(t, k, v);
		},
	});

	/*
	 * Browsers coerce null/undefined/NaN canvas coordinates to 0 and carry on;
	 * skia's native binding calls .unwrap() on them and aborts the whole process
	 * with a Rust panic that no try/catch can trap. Real datasets hit this
	 * routinely (a blank or non-numeric cell yields a null coordinate), so
	 * numeric-ish arguments are normalised back to browser semantics. Strings and
	 * objects pass through untouched so fillText/drawImage/setLineDash still work.
	 */
	const coerceArg = (a) => {
		if (a === null || a === undefined) return 0;
		if (typeof a === 'number' && !Number.isFinite(a)) return 0;
		return a;
	};

	const ctxMethodCache = new Map();
	const ctxProxy = new Proxy(ctx, {
		get(t, k) {
			if (k === 'canvas') return canvasProxy;
			const v = Reflect.get(t, k);
			if (typeof v !== 'function') return v;
			if (!ctxMethodCache.has(k)) {
				ctxMethodCache.set(k, (...args) => v.apply(t, args.map(coerceArg)));
			}
			return ctxMethodCache.get(k);
		},
		set(t, k, v) {
			// lineWidth/globalAlpha etc. are likewise sometimes assigned strings
			if ((k === 'lineWidth' || k === 'globalAlpha') && typeof v === 'string') {
				return Reflect.set(t, k, Number(v) || 0);
			}
			return Reflect.set(t, k, v);
		},
	});

	// ---- element stand-in ----------------------------------------------
	// Returned by document.getElementById for non-canvas ids.
	const elements = new Map();
	const makeElement = (id) => {
		const el = {
			id,
			style: {},
			value: values.has(id) ? values.get(id) : '',
			checked: checked.get(id) || false,
			selectedIndex: 0,
			options: [],
			innerHTML: '',
			offsetWidth: width,
			offsetHeight: height,
			appendChild() {},
			setAttribute() {},
			getAttribute() { return null; },
			addEventListener() {},
			focus() {},
			click() {},
		};
		// keep el.value and the settings store in sync
		return new Proxy(el, {
			get(t, k) {
				if (k === 'value') return values.has(id) ? values.get(id) : t.value;
				if (k === 'checked') return checked.get(id) || false;
				return Reflect.get(t, k);
			},
			set(t, k, v) {
				if (k === 'value') { setValue(id, v); return true; }
				if (k === 'checked') { setChecked(id, v); return true; }
				return Reflect.set(t, k, v);
			},
		});
	};
	const getElement = (id) => {
		if (id === 'myCanvas') return canvasProxy;
		if (!elements.has(id)) elements.set(id, makeElement(id));
		return elements.get(id);
	};

	// ---- selector parsing ----------------------------------------------
	// Only the forms js.js actually uses need to resolve to a real id:
	//   '#id', '#id option:selected', '#id:checked', '#id tr td', ...
	const parseSelector = (sel) => {
		if (typeof sel !== 'string') return null;
		const m = /^\s*#([a-zA-Z0-9_]+)/.exec(sel);
		if (!m) return null;
		return { id: m[1], rest: sel.slice(m[0].length).trim() };
	};

	const isVisible = (id) => {
		// An option's applicability is carried by its `<id>show` wrapper when one
		// exists; graph functions show/hide the wrapper, not the input itself.
		if (visible.has(id + 'show')) return visible.get(id + 'show');
		if (visible.has(id)) return visible.get(id);
		return false;
	};

	// ---- jQuery stand-in -------------------------------------------------
	function Q(sel) {
		if (!(this instanceof Q)) return new Q(sel);
		this.selector = sel;
		const p = parseSelector(sel);
		this._id = p ? p.id : null;
		this._rest = p ? p.rest : '';
		// A known id resolves to one element; unknown selectors resolve to an
		// empty set, so `.each()` over them is a no-op rather than a crash.
		this.length = this._id ? 1 : 0;

		// js.js binds a long tail of DOM/event methods (.resize, .draggable,
		// .tooltip, plugin calls...) that have no headless meaning. Rather than
		// enumerate them, any unknown method resolves to a chainable no-op.
		return new Proxy(this, {
			get(t, k, r) {
				if (k in t || typeof k === 'symbol') return Reflect.get(t, k, r);
				return function () { return r; };
			},
		});
	}

	const chain = function () { return this; };
	Object.assign(Q.prototype, {
		show() { if (this._id) visible.set(this._id, true); return this; },
		hide() { if (this._id) visible.set(this._id, false); return this; },
		toggle: chain, css: chain, addClass: chain, removeClass: chain,
		toggleClass: chain, append: chain, prepend: chain, appendTo: chain,
		remove: chain, empty: chain, on: chain, off: chain, one: chain,
		click: chain, change: chain, trigger: chain, focus: chain, blur: chain,
		mousemove: chain, mouseover: chain, mouseout: chain, ready: chain,
		scrollTop: chain, animate: chain, fadeIn: chain, fadeOut: chain,
		attr() { return undefined; },
		removeAttr: chain,
		index() { return 0; },
		get() { return this._id ? getElement(this._id) : undefined; },
		eq() { return this; },
		last() { return this; },
		first() { return this; },
		parent() { return this; },
		children() { return new Q(null); },
		find() { return new Q(null); },
		filter() { return new Q(null); },
		each() { return this; },

		val(v) {
			if (!this._id) return undefined;
			if (v === undefined) return values.get(this._id);
			setValue(this._id, v);
			return this;
		},

		text(v) {
			if (!this._id) return '';
			if (v !== undefined) return this;
			// `$('#xvar option:selected').text()` is how every graph function reads
			// which column is bound to an axis. Options are column names, so the
			// stored value is the label.
			return values.get(this._id) || '';
		},

		html(v) {
			if (v !== undefined) return this;
			return '';
		},

		prop(name, v) {
			if (!this._id) return undefined;
			if (name === 'checked') {
				if (v === undefined) return checked.get(this._id) || false;
				setChecked(this._id, v);
				return this;
			}
			if (name === 'selectedIndex') return 0;
			if (v === undefined) return undefined;
			return this;
		},

		is(what) {
			if (!this._id) return false;
			if (what === ':checked') return checked.get(this._id) || false;
			if (what === ':visible') return isVisible(this._id);
			if (what === ':hidden') return !isVisible(this._id);
			if (what === '[alt]') return false;
			return false;
		},
	});

	// jQuery static helpers actually used by js.js
	Q.isNumeric = (obj) => {
		const type = typeof obj;
		return (type === 'number' || type === 'string') && !isNaN(obj - parseFloat(obj));
	};
	Q.each = (coll, fn) => {
		if (coll == null) return coll;
		if (Array.isArray(coll) || typeof coll.length === 'number' && !isPlainObject(coll)) {
			for (let i = 0; i < coll.length; i++) if (fn.call(coll[i], i, coll[i]) === false) break;
		} else {
			for (const k of Object.keys(coll)) if (fn.call(coll[k], k, coll[k]) === false) break;
		}
		return coll;
	};
	Q.inArray = (v, arr) => (arr ? Array.prototype.indexOf.call(arr, v) : -1);
	// Analytics beacons: deliberately inert. The terminal tool must not phone home.
	const noopPromise = () => ({ done() { return this; }, fail() { return this; }, always() { return this; } });
	Q.get = noopPromise;
	Q.post = noopPromise;
	Q.ajax = noopPromise;
	Q.extend = Object.assign;
	// js.js registers a custom :textEquals pseudo-selector at load time.
	// Nothing headless uses it, but the registration must not throw.
	Q.expr = { ':': {}, createPseudo: (fn) => fn };

	// ---- window / document ----------------------------------------------
	const documentStub = {
		getElementById: getElement,
		createElement: () => makeElement('__created__'),
		querySelector: () => null,
		querySelectorAll: () => [],
		addEventListener() {},
		execCommand() { return false; },
		queryCommandSupported() { return false; },
		cookie: '',
		body: { scrollWidth: width, appendChild() {} },
		documentElement: { clientWidth: width, clientHeight: height },
	};

	const sandbox = {
		console,
		Math, Date, JSON, Number, String, Boolean, Array, Object, RegExp, Error,
		parseInt, parseFloat, isNaN, isFinite,
		setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
		clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
		requestAnimationFrame: (fn) => { if (typeof fn === 'function') fn(); return 0; },
		alert() {}, prompt() { return null; }, confirm() { return false; },
		navigator: { userAgent: 'termgrapher', platform: 'linux', clipboard: {} },
		location: { href: '', search: '', hash: '', reload() {} },
		localStorage: {
			_d: new Map(),
			getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
			setItem(k, v) { this._d.set(k, String(v)); },
			removeItem(k) { this._d.delete(k); },
		},
		XLSX: undefined,
		ga() {}, ipaddress: '',
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.self = sandbox;
	sandbox.document = documentStub;
	sandbox.$ = Q;
	sandbox.jQuery = Q;

	// js.js is instrumented with console.time/timeEnd and progress logging aimed
	// at the browser devtools. Silence it unless explicitly asked for, so it can't
	// corrupt stdout when a graph is being piped.
	if (!options.verbose) {
		const sink = () => {};
		sandbox.console = {
			log: sink, info: sink, warn: sink, debug: sink,
			time: sink, timeEnd: sink, trace: sink, group: sink, groupEnd: sink,
			error: (...a) => console.error(...a),
		};
	}

	const context = vm.createContext(sandbox);

	// ---- load third-party libraries the engine depends on -----------------
	// regression.min.js backs the trend lines on residual plots and TS forecasts.
	// These ship in the repo alongside js.js under their own permissive licences
	// (see THIRD-PARTY-LICENCES.md).
	for (const lib of ['regression.min.js']) {
		const p = path.join(ROOT, 'grapher', lib);
		if (!fs.existsSync(p)) continue;
		try {
			vm.runInContext(fs.readFileSync(p, 'utf8'), context, { filename: 'grapher/' + lib });
		} catch (e) {
			throw new Error('failed loading ' + lib + ': ' + e.message);
		}
	}

	// ---- load the upstream graphing engine -------------------------------
	const source = fs.readFileSync(path.join(ROOT, 'grapher', 'js.js'), 'utf8');
	vm.runInContext(source, context, { filename: 'grapher/js.js' });

	return {
		context,
		sandbox,
		canvas: rawCanvas,
		ctx,
		values,
		checked,
		visible,
		setValue,
		setChecked,
		getElement,
		controls: CONTROLS,
	};
}

module.exports = { createEnv };
