# Moving the UI's model into the core

`node scripts/core/move.ts` moves `application/ui/src/model/` into `application/ui/src/core/` with
the pieces that go with it, and points every importer at the new place. It computes its work from
the tree it finds, so it runs again on a fresh main after other pull requests change `model/`.

It moves:

- every tracked file under `ui/src/model/` to `ui/src/core/`, folders kept (`layout/` too);
- `backend/registry.ts` and `backend/portable-card-raised.ts`, and their tests, into `core/`;
- `backend/boot-rehearsal.ts` and its test into `backend/demo/debug/`.

It rewrites a quoted relative path only where it is a module specifier: `from`, a bare `import`,
`import()`, `vi.mock`/`doMock`/`unmock`/`doUnmock`/`importActual`/`importMock`, `import.meta.resolve`
and `new URL` (kept relative), with or without a `?raw`/`?worker` query. Importers in `ui/src` get
`#core/<path>`, the package's own `imports` (`"#core/*": "./src/core/*.ts"` in
`application/ui/package.json`), written without an extension; files inside `core/` and files outside
`ui/src` get relative paths, in the form they had (`.ts`, `.js`, extensionless); the moved files'
imports of what stayed behind are made relative to their new place.

It stops, changing nothing, and lists what it can't write: a folder's index or a `?raw` query as
`#core/*`; a quoted path to a moved file in any other place (a `readFileSync("../model/x.ts")`);
and a template-literal `import()` or an `import.meta.glob` (every element of an array too, matched
with `path.matchesGlob`) that reaches a moved file, unless every file it reaches keeps its place
relative to the file holding it (a moved file's pattern into its own moved folder survives).

Paths written out in full outside `ui/src` (scripts, docs, tests) are rewritten as text, built from
the moved files' old paths and the folders that move whole: anchored at `application/ui/src/` or
`ui/src/` (not after a `/`, so another package's `ui/src/...` is left alone), with a right boundary
(`registry.ts` doesn't match `registry.tsx`), and in the regular-expression form (`ui\/src\/...`)
too. The script ends by listing the mentions of any old path it left (a path without `ui/` in front,
or `ui/model`); the docs commit fixes those. It runs `oxfmt` over what it touched (and checks it can
run first), refuses a dirty tree, and refuses to run when `ui/src/core/` exists.

Not handled: an alias that reaches a moved file by other means than a relative specifier, and text
that spells a moved path in a way the anchors don't match (a path split over lines); the leftover
list is the net for those.

## Redoing the move on a fresh main

The branch keeps its commits in this order so a redo is "re-apply the hand edits, then run":

1. **The prep commit** (hand edits that don't need the new folder): `model/derivations.ts`
   (the workspace-only selectors out of `app/selectors.ts`), `SchemePreference` defined in
   `model/types.ts`, the registry's `TerminalKey` taken from `model/types`, the `imports` field in
   `application/ui/package.json`. Merge or cherry-pick it onto the fresh main; it rarely conflicts.
2. **The script's commits**, every one that touches `scripts/core/` (`git log --oneline -- scripts/core`):
   cherry-pick them too, oldest first; they aren't part of the prep.
3. Run `node scripts/core/move.ts` on a clean tree and commit its output.
4. **The architecture commit** (`architecture.test.ts` re-keyed for `core/`, `#core/*` read as the
   core layer, and the core's own rules): cherry-pick it; the tables it touches are additions, so
   conflicts are small. `architecture.test.ts` fails between steps 3 and 4 and only there.
5. **The docs commit** (README and docs prose, source comments and the atlas's area map and lens, which name `model/`); redo it by `grep` for what main brought new.

## What to check after

- The script ends by listing mentions of the old folder it didn't rewrite (a path without the
  `ui/` in front, such as `scripts/bench/profile/patches.ts`'s `/src/model/store.ts`): the docs
  commit fixes those.
- `grep -rn "model/" application/ui/src` for new mentions of the old folder in comments (the
  script rewrites specifiers and full paths, not prose).
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, then `pnpm build`,
  `pnpm build:try` and `pnpm --filter @novadeck/ui exec vite build --mode content-preview --outDir <scratch>`.
- The counter run's reading is unchanged:
  `pnpm --filter @novadeck/ui exec vitest run --project counters`, then `node scripts/benchmark/main.ts`.
- If a new file in `model/` imports React, the toolkit or another UI layer, it can't move into
  `core/`: move it out to the UI first (the architecture rule fails otherwise).
