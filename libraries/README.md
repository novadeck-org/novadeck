# Libraries

The mechanics the app is built on, each a package that never imports app code: hosting
terminals, the emulator, typing into TUIs, the transport between processes, the content viewers,
the build rules and the test sandbox. The app keeps the product.

## The rules

- **No app code.** A library never imports `@novadeck/protocol`, the runner client, the
  runner, the UI, the host, the relay, the atlas or a harness, by package name or by path.
  Product specifics (names, wording, environment variables, storage keys) come in as options.
  A library's README reads the same with "Novadeck" taken out.
- **Other libraries in order only.** A library imports another one by its package name, and only
  the ones its design depends on: `terminal` and `tui-input` import `emulator`, and `emulator`,
  `wire`, `viewers` and `sandbox` import none.
- **Node and browser halves are subpaths of one package.** A subpath only Node may import names
  nothing but the `node` condition in `exports`, so a browser bundle can't resolve it:

  ```json
  "./pty": { "node": { "development": "./src/pty.ts", "types": "./dist/pty.d.ts", "default": "./dist/pty.js" } }
  ```

  Every other subpath is a browser subpath. Native, server and Electron dependencies (node-pty,
  `ws`, `@orpc/server`, `electron`) are optional peer dependencies, installed by the app that
  uses those subpaths.

- **Its own package.** Every dependency it imports is in its own `package.json`, never borrowed
  from hoisting, and it keeps its own pins, patches, tests and README. pnpm reads
  `patchedDependencies` only from the root `pnpm-workspace.yaml`, so a library's patch files live
  in the library and are registered there. A dependency whose values cross package lines, as
  `zod`'s schemas do, is pinned once instead, in `pnpm-workspace.yaml`'s `catalog`, and every
  package names it `catalog:`.

## What enforces them

- **The import fence** in `.oxlintrc.json`: an override per library refuses app code by package
  name, paths into `application/`, `apps/`, `backend/`, `contract/`, `frontend/`, `harnesses/`,
  `libraries/`, `atlas/` or a sibling's `dist/` (`../../wire/dist`), or up to one of the first
  eight by name (`../harnesses`, so a library's own module one folder up takes another
  name), and the libraries outside its order; one on
  `frontend/*/src`, `apps/*/src` and `apps/desktop/renderer` (but not the desktop app's `src`, its
  main process) refuses the Node subpaths of any `@novadeck` package (`/pty`, `/host`,
  `/server`, `/electron`, `/browser/host`, `/shell`, `/headless`). oxlint takes
  `no-restricted-imports` from the last matching override alone, and a `!` pattern in one group
  allows the name in every group, so each library's override repeats the bans they all share as
  plain lists, and `scripts/libraries/fence.test.ts` lints probe files with the real config to check
  what each file ends up refusing, in each form an import takes (`import`, `import type`, `export …
  from`, `import()`). oxlint takes a folder's own config in place of the root's, so the test also
  fails on any oxlint config but the root's. It refuses ES imports, not `require()`, which the
  package graph and the typecheck stand behind.
- **The package graph** (`scripts/libraries/graph.test.ts`): a library's package.json installs no
  workspace package but the libraries its design depends on, in any kind of dependency, under its
  own name or an alias, and nothing from a path (`link:`, `file:`, `portal:`, `workspace:` with a
  path, or a bare path as pnpm reads one, a drive letter, a backslash or a tarball's name included).
  pnpm links no workspace package at the root, so a library imports only the workspace packages it
  declares. What the root installs (its dev tools, and the hoisted `electron`) still resolves from a
  library without being declared: nothing checks that a library declares those.
- **The typecheck's `rootDir`**: a relative import that leaves the library's `src`, as
  `../../wire/src` into a sibling's sources, names no folder the lint knows, and fails `tsc`
  instead, tests included. One into a sibling's build (`../../wire/dist`), whose declaration files
  `rootDir` doesn't see, the lint refuses, as it does a relative path up into another folder's
  `dist`; a package's own `dist` (`katex/dist/katex.min.css`) is a package's import, and allowed.
  So a library's typecheck reads the libraries it imports as built, and its `turbo.json` has it
  wait for their builds; its tests read their sources (see
  [docs/build-graph.md](../docs/build-graph.md)).
- **The pins check** (`scripts/libraries/pins.test.ts`): the emulator's packages are installed by
  the emulator library alone, pinned exactly, so xterm and its addons move together.
- **The browser build check** (`scripts/libraries/browser.test.ts`): the lint sees direct imports
  only, so each library's browser subpaths are bundled for the browser, and the check fails on
  any Node built-in, native module (by its `gypfile` or its `binding.gyp`) or unresolvable package
  they pull in, and on a library with no `exports` or whose every subpath is null (a null under a
  condition or in a fallback array isn't looked for). It sees imports, not globals: `process`,
  `Buffer` or `__dirname` in browser code, an import guarded by `try`, or one whose name is
  computed, get past it.

## Adding a library

```sh
pnpm new:library <name> <description>
pnpm install
```

It writes `libraries/<name>` from `scripts/libraries/template.ts`: a `package.json` with its own
dev tools, `tsconfig.json` on the shared `tsconfig.base.json`, a build config, a `turbo.json`, a
Vitest config and a README. Then fence it in: add it to `order` in `scripts/libraries/order.ts`,
give it an override in `.oxlintrc.json` like its neighbours', and add it to the list each other
library's override refuses. The fence test fails until a folder here is in its order, and until each
override refuses what the order says. The new library's `pnpm test` fails too until it has its
first test.
