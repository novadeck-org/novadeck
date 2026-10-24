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
  passes them in. Types of xterm's `Terminal` and `ITheme` come from here too.
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

pnpm reads patches from the workspace's root `pnpm-workspace.yaml`, which registers these three from
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
- `@xterm/addon-webgl` 0.19.0: `WebglRenderer` registers its cursor-blink manager with the renderer
  (`this._register(new be)` in `lib/addon-webgl.mjs`, `this._register(new m.MutableDisposable)` in
  `lib/addon-webgl.js`) in place of leaving it undisposed. The manager exists once a program turns
  blinking on (DECSET 12), and while the terminal has focus it keeps a 600 ms interval that held the
  disposed renderer alive. Upstream disposes it from 7a6e724b; drop the patch on an upgrade that has it.

## Bundling the headless emulator

`@xterm/headless`'s `module` field names a browser entry the package doesn't ship. A bundler
that builds it for Node reads its `main` field first (Vite: `ssr.resolve.mainFields:
["main", "module"]`).
