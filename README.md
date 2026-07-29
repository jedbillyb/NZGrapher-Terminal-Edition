# NZGrapher - Terminal Edition

Render [NZGrapher](https://grapher.nz/) statistical charts from the terminal.

This is a **personal, unofficial fork** of [mathsnz/NZGrapher](https://github.com/mathsnz/NZGrapher)
by Jake Wills. It is not affiliated with or endorsed by NZGrapher, and it is not
a replacement for grapher.nz - it is a command-line front end for personal use.

```
nzgrapher Cars -x Price
nzgrapher Cars -t scatter -x Weight -y Horsepower
nzgrapher Cars -t rerandmedian -x Price -y origin --out rr.png
```

## What it actually is

No graphing or statistics code was rewritten. `grapher/js.js` - all 14,975 lines
of it - is loaded unmodified and executed against a real canvas, so output is
**pixel-identical to the web version**: same layout, same statistics, same fonts.

The fork adds a `term/` directory containing only the glue:

| file | role |
| --- | --- |
| `term/env.js` | headless stand-ins for `$`, `window`, `document` and the canvas |
| `term/dataset.js` | CSV → `dataforselector`, plus stratified sampling |
| `term/render.js` | reproduces `updategraph()`'s setup and dispatches a graph |
| `term/sixel.js` | median-cut quantiser + sixel encoder for inline display |
| `term/cli.js` | argument parsing and output routing |
| `term/extract-controls.js` | generates `controls.json` from `index.php` |
| `term/smoke.js` | renders every graph type and reports which succeed |

Upstream files are left untouched, so `git pull upstream master` merges cleanly.

## Why it works

Two properties of the upstream code make this viable rather than a rewrite:

1. **The canvas surface is small.** 1,455 `ctx.*` calls across ~26 distinct
   methods - no WebGL, no compositing tricks.
2. **Graph state is a flat dictionary.** Dispatch is literally
   `window[$('#type').val()]()`, and every option is read as `$('#id').val()` or
   `.is(':checked')` over ~169 form controls. So the CLI's options map 1:1 onto
   element ids, and `controls.json` is generated from `index.php` rather than
   hand-maintained.

The one subtlety worth knowing: `.is(':visible')` is load-bearing. Each graph
function begins by `.show()`-ing the wrapper spans of the options it supports,
and later guards read `.is(':checked') && .is(':visible')`. `term/env.js` tracks
show/hide calls so that logic behaves as it does in a browser.

## Requirements

- Node 18+
- A sixel-capable terminal for inline display - foot, WezTerm, mlterm, Konsole,
  `xterm -ti vt340`. Without one, use `--out` or `--open`.
- A sans-serif system font. Upstream asks for Roboto; if it isn't installed the
  best available substitute is registered under that name automatically.

## Usage

```
nzgrapher <data.csv> [options]

  -t, --type <name>     graph type (default: dotplot)
  -x, -y, -z <column>   variable bindings
  -c, --color <column>  colour-by column

  -W, --width <px>      canvas width  (default: fit terminal)
  -H, --height <px>     canvas height
  -s, --scale <n>       supersample factor (default: 2)

  -o, --out <file.png>  write a PNG
      --open            open in your image viewer / browser
      --stdout          raw PNG to stdout, for piping

      --set k=v         set any NZGrapher control (repeatable)
      --on / --off <id> toggle a checkbox option (repeatable)

  sampling:
      --sample-by <cols>    strata columns, e.g. Species,Gender
      --sample-n <n>        rows per stratum
      --sample-prop <f>     fraction of each stratum (proportional allocation)
      --sample-size <spec>  explicit counts: "Tok / M=5,Tok / F=5"
      --seed <v>            reproducible draw
      --show-sample         print the strata table

      --list-types      list graph types
      --list-columns    list columns in the dataset
      --list-datasets   list bundled datasets
      --list-options    list every control --set/--on/--off accepts
```

## Sampling

Take a stratified sample to represent a population, then graph it:

```sh
nzgrapher Kiwi -x 'Weight(kg)' -y Gender \
  --sample-by Species,Gender --sample-n 8 --seed 42 \
  --on highboxplot --show-sample
```

```
sample stratified by Species x Gender, seed 42
  GS / F                      8 of 81
  GS / M                      8 of 82
  NIBr / F                    8 of 140
  NIBr / M                    8 of 135
  Tok / F                     8 of 143
  Tok / M                     8 of 119
  total                      48 of 700
```

Two deliberate differences from the web version, which samples by deleting rows
from the on-page table:

- **Any number of stratifying columns.** Upstream's `#sampleon` takes a single
  column; here `--sample-by` takes a list, so `Species,Gender` gives the six
  strata above rather than three or two.
- **`--seed` makes a draw reproducible**, so a sample can be quoted in write-ups
  and regenerated later. The web version has no equivalent.

`--sample-prop 0.1` allocates proportionally instead of equally, and
`--sample-size` sets strata individually when you want unequal allocation.

Datasets resolve by name from the bundled set (`Cars`, `Kiwi`, `Sharks`, …) or
by path to any CSV of your own. Graph types accept short names, so `scatter`
works as well as `newscatter`.

Because options map onto upstream control ids, anything the web UI can toggle is
reachable: `--on boxplot`, `--on gridlines`, `--set regtype=Quadratic`.

## Status

All 26 graph types render:

```
$ npm run smoke
26/26 graph types rendered
```

That means they execute and produce a canvas - not that every type is
well-exercised. Types expecting a particular data shape (summary-data bar graphs
and histograms want a frequency column) draw an empty chart until given suitable
input. The animated teaching tools render their final frame rather than
animating.

Not yet done: variable filtering and computed variables (upstream's `filterdiv`
and `newvar*`), `.nzgrapher` session file import - though the format is just
`{setval, checkboxes}` over the same control ids, so it maps directly onto
`--set`/`--on`.

## Install

```sh
git clone https://github.com/jedbillyb/NZGrapher-Terminal-Edition.git
cd NZGrapher-Terminal-Edition
npm install
node term/cli.js --help
```

## Licence and provenance

Upstream NZGrapher is **source-available, not open source**, under the NZGrapher
Source-Available Licence (see `LICENCE.md`, retained unmodified). In particular
it restricts commercial use, redistribution, and hosting outside this repository.

This fork exists on GitHub under GitHub's Terms of Service §D.5, which grants
users the right to fork public repositories. It is deliberately **not**
distributed anywhere else - no npm, no package registries, no hosted builds -
and `package.json` sets `"private": true` to keep it that way.

If you want to use NZGrapher, use the real thing at **[grapher.nz](https://grapher.nz/)**.
It is free for New Zealand schools and it is where the work actually lives.

Third-party libraries bundled by upstream (jQuery, SheetJS, regression.js,
html2canvas) carry their own permissive licences - see `THIRD-PARTY-LICENCES.md`.

Upstream's original README is preserved as `README.upstream.md`.
