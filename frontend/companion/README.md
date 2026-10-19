# @novadeck/companion

The companion pane: what a terminal shows beside its output. The taskbar of the items on a
terminal's bar, the peek over a slot, the pane that draws the shown item (an image, a code
file, a Markdown file's document view, a page, a plan in its editor, the messages), the window
an item can be undocked into, the stores behind them, and the bar drag that carries a slot to
a terminal, a view or out into a window.

## Contract

- **It depends on `core`, `toolkit` and `viewers`, and on no other frontend package.** Not
  `frontend/ui`, `frontend/runner-adapter` or any backend. Two checks in `scripts/workspace/graph.test.ts` hold this: the
  manifest edges (what it declares, and what those reach), and a source check that no relative
  import in a frontend package's `src` leaves that package's folder, so `../../ui/src/...`
  can't bypass the manifest. The host (`frontend/ui`) composes it and passes in what it needs: the workspace's
  items and each terminal's bar (`TerminalCompanion`'s props), the commands that act on them,
  and the `Panes` store it creates once.
- **A pane reads state and never writes it.** `Panes` (`state.ts`) is the one place that loads
  content and writes plans, content and the revealed item; the views read it through
  `use-panes.ts`. The items and the bar are core's workspace store, and mail is core's
  `Messages`.
- **CodeMirror stays out of the first chunk.** The plan editor loads through `lazy()`
  (`CompanionPane.tsx`, `DocumentViewer.tsx`), and `state.ts` loads `@novadeck/viewers/sync` and
  `./plan-editor/notes` with `import()`. A change that imports them statically pulls the editor
  into every window and can break the try build's first-load budget; compare the builds' chunk
  lists when touching either. The graph test keeps `@codemirror/*` imports inside
  `src/plan-editor/`.
- **The window's controls are the host's.** `TerminalCompanion` declares the one callback it
  gets from a window (`onReveal`) as its own type, so the package never imports `WindowShell`.

## Subpaths

Only what the host imports: `./TerminalCompanion`, `./UndockedWindow` (the pane in its
terminal, and an item in a window of its own), `./state` (`createPanes`, `Panes`, the plan
actions), `./bar` (`barMembers`, `composeBar`), `./mail` (`useHasMail`, `useMailBadge`),
`./TabKinds` (the kinds' marks on a terminal's tab), `./artifact-icons` (`iconOf`),
`./drag-session` (`createDragSession`, `DragSessionContext`, `useDrag`, `useDragSession` and
their types: the views' drop spaces read it too) and the recipe stylesheets (`./taskbar.css`,
`./peek.css`, `./pane.css`, `./artifact.css`, `./mail.css`, `./prose.css`, `./syntax.css`).
`src/test.ts` is Vitest's re-export for the package's own tests and is not exported. A module is
exported when something outside imports it; the rest of `src` is internal.

## Tailwind

The package writes utilities in its TSX, and the UI's `styles.css` scans `src` with `@source`
(and leaves the tests out). It writes no utility that no other scanned folder writes, so the
build kit has no guard for it (as for `terminal-views`); the screenshots of the pane hold the
scan. The recipe stylesheets are imported by `styles.css` into `layer(components)` at the
places they always had, so the cascade holds.
