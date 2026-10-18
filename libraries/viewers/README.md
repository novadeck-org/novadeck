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
- `./markdown`: `mountMarkdown`, a text formatted as a document and edited in place:
  formatting marks show on the lines being edited, tables edit cell by cell, task lists tick.
  Outside changes apply as a minimal line diff, outside undo history, with the cursor kept;
  the person's edits alone reach `onEdit`. The text breaks its lines with `\n`: a host whose
  file uses `\r\n` converts on the way in and out, as offsets count `\n` as one character.
  `editable()` switches editing on the live viewer,
  `ranges` set a class on lines, `extensions` add editor behaviour, and `rowAnnotations` lets
  a host write a short text into table rows. It scrolls in its nearest scrolling ancestor.
  `@codemirror/state` and `@codemirror/view` are peer dependencies, since a host's extensions
  cross the boundary and two copies would break them. `findTables` finds tables by offset.
- `./markdown.css`: the markdown viewer's looks, themed through `--md-*`; its header lists them.
- `./text`: `outline`, the headings of a Markdown text, with no editor behind it.
- `./sync`: `lineChanges`, `distance` and `merge`, how Markdown texts differ and merge.
  Built on CodeMirror's state, so kept apart from `./text`.
- `./browser`: `mountBrowser`, a web page: live in Electron's `<webview>`, reporting where it
  is and how its load went, going back, forward or reloading, quiet while out of sight; or,
  where live pages aren't available, a snapshot of it. It opens where the person had taken
  the page.
- `./browser.css`: the browser viewer's looks, themed through `--browser-*`.
- `./browser/host` (Node only): the pages' lockdown for Electron's main process:
  `attachPage` settles a page view's settings as it attaches (no preload, no Node, a
  sandbox, the pages' session in memory, http(s) only), `guardPage` keeps it to http(s) and
  sends a window it opens to the browser only right after the person's click or key, and
  `lockPagesSession` refuses the session every permission, download and file. Nothing in
  their options can loosen that. Electron is an optional peer dependency, needed only here.
- `./react`: `useViewer`, a ref that mounts a viewer into its element and keeps its state by
  id, and the viewer once mounted. React is an optional peer dependency, needed only here.

## Tests

They run in Chromium (Vitest's browser mode), since keeping a viewer's place is about real
layout and scrolling; the pages' lockdown, which runs in Electron's main process, is tested
in Node.
