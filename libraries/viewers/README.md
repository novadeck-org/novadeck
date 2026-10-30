# @novadeck/viewers

Content viewers behind one contract: code, changes, image, markdown and web pages, each mounted into
an element, keeping its scroll and place across remounts through state its app stores.

A viewer doesn't know what it's shown for. Its app chooses which viewer shows what, gives
it an element and content, and stores what `state()` returns when it lets the viewer go, to
hand back as `saved` to the next viewer of the same thing.

## Subpaths

- `.`: the contract (`Viewer`, `Mount`, `ViewerState`, `Target`) and `createKept`, a
  small least-recently-used store an app can keep viewer states in.
- `./code`: `mountCode`, a read-only listing with line numbers from any first line, an
  emphasized range it first scrolls into view, and highlighting that loads each language's
  parser the first time it's needed; `highlightLines` and `languageOf` for code highlighted
  elsewhere.
- `./code.css`: the code viewer's looks and the `.tok-*` highlighting classes. Its header
  lists the tokens an app sets to theme it (`--code-*`, `--syntax-*`).
- `./diff`: `mountDiff`, a read-only change: a repository's files against a base, each
  under a header saying how it changed, with its hunks as numbered lines, highlighted as the
  code viewer highlights, the old and new sides apart. A long change fills a batch of rows at
  a time, and a new change keeps the rows of every file that didn't change, and the place by
  the file and row it was at.
- `./diff.css`: the diff viewer's looks, themed through `--diff-*` and the code viewer's
  `--code-*`; it takes the `.tok-*` classes from `./code.css`.
- `./image`: `mountImage`, an image on a canvas: fitted whole (never enlarged), or zoomed
  from half its fit to 3200% and moved about. Pinch or Ctrl/⌘+scroll zooms around the
  pointer, a drag moves it at any zoom and a scroll once it's zoomed or moved (a fitted one
  leaves the wheel to the page), a double-click zooms in there and back to fit, and keys do
  each once it's reached by Tab (after a click, typing goes on to the app). Once it's moved
  or zoomed, a chip over it shows how far and takes it back to fit. Its zoom and the point
  at its centre are kept in its state, so it reopens on the same view at any size; `zoom()`
  sets it.
- `./image.css`: the image viewer's looks, themed through `--image-*`.
- `./markdown`: `mountMarkdown`, a text formatted as a document and edited in place:
  formatting marks show on the lines being edited, tables edit cell by cell, task lists tick.
  Outside changes apply as a minimal line diff, outside undo history, with the cursor kept;
  the person's edits alone reach `onEdit`. The text breaks its lines with `\n`: an app whose
  file uses `\r\n` converts on the way in and out, as offsets count `\n` as one character.
  `editable()` switches editing on the live viewer,
  `ranges` set a class on lines, `extensions` add editor behaviour, and `rowAnnotations` lets
  an app write a short text into table rows. It scrolls in its nearest scrolling ancestor.
  `@codemirror/state` and `@codemirror/view` are peer dependencies, since an app's extensions
  cross the boundary and two copies would break them. `findTables` finds tables by offset.
- `./markdown.css`: the markdown viewer's looks, themed through `--md-*`; its header lists them.
- `./markdown-blocks`: `parseMarkdown`, a small forgiving reader of the Markdown an agent
  writes (paragraphs, headings, lists, quotes, fenced code, tables, emphasis, inline code,
  links), returning a tree for an app to draw element by element, so nothing in the text is
  ever read as HTML; `parseInline`, `safeHref` (only web links leave) and `fenceFile`, the
  file name whose language a fence's info string asks for, to give `languageOf`. It imports
  nothing and doesn't edit: `./markdown` is the editor.
- `./text`: `outline`, the headings of a Markdown text, with no editor behind it.
- `./sync`: `lineChanges`, `distance` and `merge`, how Markdown texts differ and merge.
  Built on CodeMirror's state, so kept apart from `./text`.
- `./browser`: `mountBrowser`, a web page: live in Electron's `<webview>`, reporting where it
  is, how its load went and what goes wrong on it, going back, forward or reloading, quiet
  while out of sight, and resting as a picture of itself while its app says the person
  isn't at it; laid out as a desktop's window or a phone's screen, scaled down to fit; or,
  where live pages aren't available, a snapshot of it. It opens where the person had taken
  the page.
- `./browser.css`: the browser viewer's looks, themed through `--browser-*`.
- `./browser/main` (Node only): the pages' lockdown for Electron's main process:
  `attachPage` settles a page view's settings as it attaches (no preload, no Node, a
  sandbox, the pages' session, kept on disk so sign-ins last, http(s) only), `guardPage`
  keeps it to http(s) and lets a window it opens through only right after the person's
  click or key: a sized popup, as a sign-in's, in an app window on the same session
  (`signInWindow`), anything else in the browser; `lockPagesSession` refuses the session
  every permission, download and file, and `pickPasskeys` has the person pick the passkey a
  page signs in with when it names none and more than one fits. A sign-in window takes only
  its size from the page, and its title starts with its site. Nothing in their options
  can loosen that. `countSignIns` tells how many sign-in windows a view has open, which
  close with it. `phonePage`, `emulatePhone` and `holdPhoneLoads` make a view act as a
  phone's, `picturePage` takes the picture a resting page shows, `watchPageRequests` tells
  of the session's failed requests, and `createLooker` gives an agent a look at a page no
  pane shows live, loaded out of sight in a window of its own.
- `./browser/sign-in`: the word of how many sign-in windows a page view has open, from the
  desktop app to its viewer, which keeps the page live meanwhile.
- `./browser/trouble`: the word of a page's failed requests, from the desktop app to its
  viewer, and `Trouble`, what the viewer reports going wrong on a page.
- `./react`: `useViewer`, a ref that mounts a viewer into its element and keeps its state by
  id, and the viewer once mounted. React is an optional peer dependency, needed only here.

Electron is an optional peer dependency too, needed only by `./browser/main`.

## Tests

They run in Chromium (Vitest's browser mode), since keeping a viewer's place is about real
layout and scrolling; the pages' lockdown and an agent's looks, which run in Electron's main
process, are tested in Node.
