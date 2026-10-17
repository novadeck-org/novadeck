# @novadeck/viewers

Content viewers behind one contract: code, image, markdown and web pages, each mounted into
an element, keeping its scroll and place across remounts through state its host stores.

A viewer doesn't know what it's shown for. Its host chooses which viewer shows what, gives
it an element and content, and stores what `state()` returns when it lets the viewer go, to
hand back as `saved` to the next viewer of the same thing.

## Subpaths

- `.`: the contract (`Viewer`, `Mount`, `ViewerState`, `Target`) and `createKept`, a
  small least-recently-used store a host can keep viewer states in.
- `./code`: `mountCode`, a read-only listing with line numbers from any first line, an
  emphasized range it first scrolls into view, and highlighting that loads each language's
  parser the first time it's needed; `highlightLines` and `languageOf` for code highlighted
  elsewhere.
- `./code.css`: the code viewer's looks and the `.tok-*` highlighting classes. Its header
  lists the tokens a host sets to theme it (`--code-*`, `--syntax-*`).
- `./image`: `mountImage`, an image fitted or at its actual size, its zoom kept in its
  state with its place; `zoom()` and `onZoom` let a host draw the control.
- `./image.css`: the image viewer's looks, themed through `--image-*`.
- `./react`: `useViewer`, a ref that mounts a viewer into its element and keeps its state by
  id, and the viewer once mounted. React is an optional peer dependency, needed only here.

## Tests

They run in Chromium (Vitest's browser mode), since keeping a viewer's place is about real
layout and scrolling.
