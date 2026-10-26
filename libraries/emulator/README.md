# @novadeck/emulator

The terminal emulator: xterm.js and its addons pinned and patched in one place, the
character-width rule every emulator shares, and helpers that need only an emulator.

## Subpaths

- `./width`: `unicodeVersion`, `cells(text)`, the columns a string takes as every emulator here
  draws it, and `applyWidths(terminal)`, which sets a browser or headless emulator to count them
  so. Every emulator goes through `applyWidths`: one that counts otherwise puts a screen another
  gives back on different rows.
- `./browser`: `createView(element, options)`, xterm's browser `Terminal` opened in an element with
  the width rule applied, the fit and web-links addons loaded, and links, theme, font and fit behind
  a `View`, which tells of each change of renderer (`onRendererChange`) so its owner fits it again;
  and the pool that draws views with WebGL (`webglRenderers`, `createRenderers`,
  `ScreenRenderer`; `stats()` and `watch()` give the pool's counts: waits, steals, swaps, contexts
  lost, loads failed, pty resizes a swap caused, and screens left on the DOM). The app resolves its theme, its link policy and which views want WebGL, and
  passes them in. `View.setLigatures(on)` is the one mechanic for ligatures: while it is on and WebGL
  draws the view, runs the bundled JetBrains Mono joins (`=>`, `!=`, `<!--`) reach WebGL as one
  glyph each; the DOM renderer draws them from its text, which the page's CSS allows. Types of
  xterm's `Terminal` and `ITheme` come from here too.
- `./browser.css`: xterm's stylesheet, for the browser emulator's screens.
- `./headless` (Node only): the emulator without a view, and what needs only it.
  - `createScreen({ cols, rows, scrollback })`: a screen that counts widths as `./width` says and
    has its serializer loaded; the type is `Screen`. Every headless emulator goes through it.
  - `readScreen(screen)`: the screen as `ScreenText`: its rows, wrapping, the rows drawn full to
    the last column, dim cells blanked, the cursor, bracketed paste and the alternate screen.
  - `snapshot(screen, { fits, mouse })`: the screen serialized, with the mouse encoding the
    serializer leaves out, and as much scrollback as `fits` accepts (halved until it does);
    undefined when not even the visible screen fits. `trackMouse(screen)` follows that encoding
    (`MouseEncoding`), and `mouseReporting(tracking, encoding)` says which reports a program reads.
  - `matchReport(data, reporting)`: the terminal's own reply at the start of data (a query's
    answer, a mouse or focus report), how long it is, and what it is to the program (`Reporting`).
  - `transcript(screen, maxChars)`: the screen and its scrollback as text that draws them again,
    null when blank or too large to keep; `replay(screen, text, separator?)` draws it on a fresh
    screen, then the separator on the line below the last one drawn.
  - `IMarker`: xterm's marker type, for a line kept track of as the screen scrolls.

## Pins

The emulator's packages are pinned exactly here, and nowhere else: xterm and its addons are
released together, so an upgrade moves all of them in one change.

## Patches

pnpm reads patches from the workspace's root `pnpm-workspace.yaml`, which registers these from
this library's `patches/`. pnpm refuses an install whose patch no longer matches its pinned version,
so an upgrade can't drop one unnoticed; each is made again for the new version, or dropped once a
release fixes what it fixes.

- `@xterm/addon-unicode-graphemes` 0.4.0: the width table is read with
  `new DataView(e.buffer, e.byteOffset, e.byteLength)` in place of `new DataView(e.buffer)`, so it
  reads right from a typed array that sits inside a larger buffer.
- `@xterm/xterm` 6.0.0: `Viewport._sync` sizes the scroll area as
  `dimensions.css.cell.height * this._bufferService.rows` in place of
  `dimensions.css.canvas.height`, in both `lib/xterm.js` and `lib/xterm.mjs`. The bundles are
  minified, so the patch rewrites the whole long line that holds the expression. While a screen
  is out of view, xterm leaves a resize for its renderer until an idle moment, and the canvas
  height keeps the old size meanwhile. Output that scrolled before then clamped the scroll
  position short of the bottom, which xterm took for the person scrolling up: the screen stopped
  following its program until they scrolled down or typed. Upstream reports the same stale
  height as [#6117](https://github.com/xtermjs/xterm.js/issues/6117).
- `@xterm/xterm` 6.0.0, the same two bundles: the DOM renderer's `WidthCache` shares its
  measurements. Each renderer kept its own, so a screen drawn fresh (after the WebGL renderer
  hands a screen back, or when a view opens) measured every glyph again, a forced layout each:
  about 1,360 of them, 203 ms on a real GPU, when ten terminals switched to the Canvas view. Now the measurements
  live on the `document`, under `Symbol.for("novadeck.xterm.widths")`, one entry per font family,
  size, weight, bold weight and device pixel ratio, each with its flat and bold/italic tables. A
  screen takes the entry its font names, and measures only what the entry lacks. The entry also
  remembers the width of a `W` it was filled under. Wherever xterm used to empty a cache (a change
  of character size or pixel ratio, which every opening screen causes too) and wherever a screen
  moves to another font after its first, the screen measures `W` again, one read, and empties the
  entry only when that differs, so an opening screen leaves its siblings' widths alone while a
  font that loaded after the fallback was measured is measured afresh. The document's `fonts`
  `loadingdone` empties every entry, for fonts that load with the same metrics as their
  fallback. A width of 0 (an element with no layout) is still never kept. The table of bold, italic and
  wide strings is kept in two generations of 8192: when the current one fills, it becomes the
  second and a fresh one starts, and a string found in the second moves to the current without
  measuring. What a screen still draws is never dropped, so any set of strings up to a generation
  stays measured (a full screen is 2 to 7 thousand cells, several screens mostly share theirs),
  and the memory is bounded at two generations. A set larger than a generation keeps measuring part of it.
  Widths and letter-spacing are what they were, apart from sharing a screen's measurements with
  the others. Like the viewport fix, this is made again on xterm 6.1: the same class, in both
  bundles, unless 6.1 shares its widths itself. `src/widths.test.ts` pins it.
- `@xterm/xterm` 6.0.0, the same two bundles: `getCoordsRelativeToElement` (`src/browser/input/Mouse.ts`)
  and `moveTextAreaUnderMouseCursor` (`Clipboard.ts`) divide the pointer's offset in the element by
  the element's scale, `getBoundingClientRect().width / offsetWidth` on each axis, before taking the
  unscaled padding or placing the textarea. The Canvas view scales a terminal with a CSS transform;
  xterm took client pixels, which the scale stretches, over cell sizes it doesn't touch. At zoom 0.5 a
  click on column 40, row 3 reported column 21, row 2, and a drag over columns 10 to 19 selected 5 to 9,
  with either renderer. Check xterm 6.1 for a fix; otherwise make it again in the same two functions.
  `src/pointer.test.ts` pins it in each bundle, and terminal-views' `src/zoom.spec.ts` checks the
  reports and the selection in a real browser at scales 0.5, 1 and 1.5.
- `@xterm/xterm` 6.0.0, the same two bundles: the DOM renderer's `_updateDimensions` measures a cell
  as the WebGL renderer does: the device width of a character is `Math.floor(charWidth * dpr)`, and
  the CSS cell is `device.cell.width / dpr` (it was the measured width, and the rounded canvas over
  the columns), and the CSS cell height is `device.cell.height / dpr` (it was the rounded canvas height
  over the rows, which differs from WebGL's at a fractional ratio: a box fit one row more or less, at
  ratio 1.25 a 796 x 228 box 14 rows against 15). The renderers disagreed, so a screen that changed renderer (a context stolen, lost
  or given back, ligatures toggled) fit another number of columns and resized its pty, and an agent's
  TUI redrew: 13 px JetBrains Mono advances 7.8 px, which is 7 px in WebGL, so 112 columns against
  100 in an 800 px box at a ratio of 1. The DOM renderer fits each span to the cell with letter-spacing
  (`_setDefaultSpacing` reads the cell, so it follows), so its text draws at WebGL's pitch, about
  0.8 px tighter per glyph at 13 px. The shared width cache holds glyph
  widths, not the cell, and is unaffected. Make it again on xterm 6.1 in `DomRenderer._updateDimensions`
  unless the DOM renderer rounds the same way. `src/cell.test.ts` pins it in each bundle, and
  terminal-views' `src/grid.spec.ts` checks both renderers fit the same columns and rows in a real
  browser at ratios 1, 1.25, 1.5 and 2.
- `@xterm/xterm` 6.0.0, the same two bundles: `WriteBuffer._innerWrite` catches a chunk whose
  parsing throws, as one does when a buffer row the cursor or renderer expects is missing. It throws
  the error again on its own (`queueMicrotask`, as xterm does for an async handler's), calls that
  chunk's callback with it, and goes on with the next chunk. Unpatched, the throw left the chunk
  queued and its callback uncalled, and as the queue never emptied no write was parsed again: a
  screen waiting on one stayed on "Loading output…" for good. `writeTo` (`src/write.ts`) rejects
  with the error, and the terminal library's view then draws the host's screen afresh, as the parser
  may be left mid-sequence. Upstream has the same loop; drop the patch on an upgrade that catches
  there. `src/write.test.ts` pins it in each bundle.
- `@xterm/addon-webgl` 0.19.0: `WebglRenderer` registers its cursor-blink manager with the renderer
  (`this._register(new be)` in `lib/addon-webgl.mjs`, `this._register(new m.MutableDisposable)` in
  `lib/addon-webgl.js`) in place of leaving it undisposed. The manager exists once a program turns
  blinking on (DECSET 12), and while the terminal has focus it keeps a 600 ms interval that held the
  disposed renderer alive. Upstream disposes it from 7a6e724b; drop the patch on an upgrade that has it.
- `@xterm/addon-webgl` 0.19.0, the same two bundles: the glyph atlas draws a run of two or more
  ASCII punctuation characters (what a joined ligature is) scaled sideways to its cells, by
  `cells * deviceCellWidth / measureText(run).width`, in place of at the font's own advance; an underlined run's descender outline (`strokeText`) takes the same scale. A cell is
  `floor(advance * dpr)` wide, so at 13 px JetBrains Mono (7.8 px) and a ratio of 1 a run of three
  drew 2.4 px past its cells, onto the next glyph; at a ratio of 2 (15 against 15.6 px) it
  stayed inside by its side bearings, and at 1.25 it spilled by 0.2 cell. The one `fillText` and one `strokeText` call,
  as before for every other string. Drop it if upstream fits joined runs to their cells.

## Ligatures

JetBrains Mono makes a ligature by contextual substitution: `=>` is two glyphs swapped for ones
that join. `src/ligature-table.ts` lists the sequences (up to four glyphs) that trigger it, read from
the bundled font by `pnpm run ligature-table` (the font's GSUB rules, run through `font-ligatures`
in Node; dev only, nothing of it ships). `ligatureRuns(text)` finds them in a line and merges
overlapping or touching ones into runs, which xterm's character joiner hands to WebGL as one glyph
each. A run is at most 32 cells, and fewer where a cell has more device pixels (480 device pixels in all): WebGL's atlas keeps a glyph past 512 px on one overflow page that evicts nothing, so a screen of progress bars of many lengths and colours filled it and drew nothing, and a glyph past the 2048 px texture is clipped. A longer run is cut only where the font draws the same glyphs either side: inside a stretch of one repeated glyph (a line of `=`, a progress bar's body), at least 8 cells from both its ends (the font's rules reach four glyphs into a stretch; `ligature-font.test.ts` measures that for every glyph and compares glyph ids of every cut part with the whole line's at widths 4, 17, 20, 30 and 32), in parts of at least 8 cells. Where no such cut falls within the cap, the cells up to the next one (or the run's end) are left unjoined and draw as plain glyphs, as with ligatures off: a markdown row `|---|---|…`, `-->-->…` or `=>=>…` past the cap is plain, since a cut in them changes glyphs (a tee, a flipped pairing), and a few plain cells beat a glyph the font would not draw. Where fewer cells fit the cap than the longest sequence (an extreme zoom), nothing is joined. The joiner is registered only while the first font family is JetBrains Mono, whose table it is. Two limits are known and left: (a) a tangle wider than the cap (`|---|---|…` without spaces, `-->-->…`, `=>=>…`, `<--><-->…`) draws plain on WebGL where the DOM renderer joins it; the font does allow glyph-exact cuts in them (around each `|`, between `>` and `-`), which a table of safe boundaries made from the font, as the sequences are, would recover; (b) the table lists the glyphs a ligature joins, not a neighbour that stops one, so `<-1>` and `[--->` draw an arrow on WebGL where the font draws plain (`it.fails` in the font test). A run is shaped by the browser, so the font decides what inside it joins: a run that takes in a
glyph the font leaves plain draws it plain. `src/ligature-font.test.ts` holds the table to the font:
every cell the font joins is in a run, and a run alone joins what it did in its line. A change of
font version fails it until the table is made again.

## Bundling the headless emulator

`@xterm/headless`'s `module` field names a browser entry the package doesn't ship. A bundler
that builds it for Node reads its `main` field first (Vite: `ssr.resolve.mainFields:
["main", "module"]`).
