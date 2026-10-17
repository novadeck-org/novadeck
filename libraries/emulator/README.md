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
  `ScreenRenderer`). The app resolves its theme, its link policy and which views want WebGL, and
  passes them in. Types of xterm's `Terminal` and `ITheme` come from here too.
- `./browser.css`: xterm's stylesheet, for the browser emulator's screens.
- `./headless` (Node only): xterm's headless `Terminal`, the serialize addon, and `ScreenText`,
  a screen read as text.

## Pins

The emulator's packages are pinned exactly here, and nowhere else: xterm and its addons are
released together, so an upgrade moves all of them in one change.

## Patches

pnpm reads patches from the workspace's root `pnpm-workspace.yaml`, which registers these two from
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

## Bundling the headless emulator

`@xterm/headless`'s `module` field names a browser entry the package doesn't ship. A bundler
that builds it for Node reads its `main` field first (Vite: `ssr.resolve.mainFields:
["main", "module"]`).
