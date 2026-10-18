# Atlas

A dev-only map of what Novadeck is built of, read from the code: the runtime, the areas,
the API, the data, the agent surface, hand-written flows, and lenses into the UI and the runner.
People read it as a web app (`pnpm atlas`); agents read it as briefs.

# Architecture Briefs

Before you change, review or explain a part of the code, ask Atlas for a brief instead of
reading through the folders. From the repository root:

```sh
pnpm -s atlas:brief                    # index: every area token with its purpose
pnpm -s atlas:brief runner/terminals   # an area
pnpm -s atlas:brief terminals.create   # a procedure, down to the SQL it runs
pnpm -s atlas:brief terminal/add       # a UI action, from dispatch to the runner
pnpm -s atlas:brief table:terminals    # a table, its store methods and who reaches them
pnpm -s atlas:brief state              # how UI state and calls are wired
```

`node tools/atlas/brief/main.ts <subject>` is the same without pnpm. A brief is short Markdown,
read fresh from the source on every call (it builds `@novadeck/wire` and `@novadeck/protocol` first
if they are missing or stale; the same goes for `extract` and `check`), with `file:line` anchors to open next.

- Subjects: an area token, a procedure (`namespace.name`), a UI action (`prefix/name`), a
  table, an MCP tool or a flow. Prefix a kind (`area:`, `procedure:`, `action:`, `table:`,
  `tool:`, `flow:`) when a name is ambiguous; the command says so and exits 1.
- Overviews: `api`, `data`, `state`, `flows`, `harnesses`.

## Area tokens

Areas are named by tokens that mirror where the code lives: the package, then one
segment per folder (`runner/terminals` is `backend/runner/src/terminals`,
`ui/backend/runner` is `application/ui/src/backend/runner`). Use the tokens when you
report, plan or describe changes, so people and agents name the same thing the same way.

## Reading a brief

Atlas reads the source statically, a few calls deep, by matching names. Treat what it
says as a map, not a proof:

- "No store call found" means the trace stopped, not that the code never touches the
  database. Callbacks and dynamic dispatch are invisible to it.
- "Inferred" links (a UI action reaching a procedure through a state diff) are guesses
  from the reducer; confirm them in the adapter before relying on them.
- Error lists come from the handler and the router only; deeper helpers may raise more.
- Before you act on an absence ("nothing writes this table"), check the source.

The full data is `tools/atlas/src/generated/atlas.json` after `pnpm --filter @novadeck/atlas
extract`, for `jq`; it is large, so prefer briefs.

# Changing Atlas

- `extract/` reads facts from the code; `content/` holds the little that is written by
  hand: package roots and a purpose per area token (`areas.ts`), the runtime map
  (`runtime.ts`), flows (`flows.ts`) and library roles (`stack.ts`); `src/` is the web app,
  which renders only the generated data; `brief/` renders it as text.
- Prefer extracting to curating. Whatever is curated points into the code with an anchor
  (`{ file, text }`), and `pnpm --filter @novadeck/atlas check` fails when one rots, when
  source under `application/`, `harnesses/` or `engines/` belongs to no area, or when a
  note names an area that no longer exists. A new folder becomes a token on its own; give
  it a purpose in `content/areas.ts`. A new package needs a root there.
- Every structure an extractor depends on (a type, a class, a marker line) is expected, not
  assumed: when it is gone, or a scan that must find something finds nothing, the extractor
  reports it as broken (`anchors.expect` / `anchors.report`) and `check` fails. Add the same
  for any new extractor.
- Sources are read with LF endings and paths are posix, so Windows checkouts trace the same.
- Where a trace is unsure, show it as unsure: a hollow or dashed mark on the page, a plain
  sentence in a brief. Never let an untraced path look complete.
- The look replicates Novadeck's Graphite theme and chrome (`src/index.css`,
  `src/chrome.css`) rather than importing `@novadeck/ui`; copy again when those change.
- Atlas has no build script and never ships. Checks: `pnpm --filter @novadeck/atlas check`,
  `typecheck` (it runs `extract` first, because `src/generated/atlas.json` is gitignored) and
  `test`, plus the repository's `oxlint` and `oxfmt`. `tools/atlas/turbo.json` turns off turbo's cache
  for `test` and `typecheck`: they read the whole repository, which turbo does not hash.
