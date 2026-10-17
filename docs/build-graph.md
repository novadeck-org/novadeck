# The build graph

What each turbo task waits for, and why. The graph lives in `turbo.json` at the root, with
a `turbo.json` beside a package only where that package differs.

## Packages read each other's source, outside builds

The packages others import as built (the protocol, the harnesses, the libraries) export their
source under the `development` condition, beside their `dist`; the runner exports only source,
and the relay its binary's path. Tests and typechecks read the source; builds read `dist`.

- **Vitest** takes `development` itself (it runs Vite outside production), so a package's tests
  run against its dependencies' source with nothing built first.
- **tsc** takes it from `customConditions: ["development"]` in the app's and the harnesses'
  `tsconfig.json`, so a typecheck reads the same files the tests do. The host's and the UI's
  add `node`, which their `Bundler` resolution leaves out, so a `node`-only export such as the
  sandbox's or the terminal library's resolves (the UI's typecheck follows the runner's source,
  which the UI's adapter tests start, into them).
- **Builds** reset it (`customConditions: []` in `tsconfig.build.json`) and read their
  dependencies' built types, as a published consumer would. So `build` keeps `^build`.
- **Libraries' typechecks read the libraries they import as built**: a library's `rootDir` is
  its `src` (the fence in [libraries/README.md](../libraries/README.md)), which another
  library's source would leave. A library's `turbo.json`, from the template, has its typecheck
  wait for `^build`. Its tests read source, as everyone's do.
- **Native `require` in a test also reads source**: Vitest hands Node the same conditions, so
  a `createRequire` of a workspace package loads TypeScript whose `.js` imports Node can't
  resolve. Import workspace packages instead; atlas does.

## `test` and `typecheck` wait for `^transit`, not for builds or each other

`transit` is a task no package has a script for. Waiting for `^transit` runs nothing, but
puts every dependency's inputs into the task's hash: a package's tests miss the cache when
a package it imports changes, as they did when they waited for `^build`. Without it, dropping
`^build` would let a cached pass stand over a changed dependency.

- `test` no longer waits for `^test`: a dependency's tests failing says nothing about whether
  this package's tests can run, and running them first only made the graph serial.
- `typecheck` no longer waits for `^typecheck`, for the same reason, nor `^build`, as it reads
  source.
- `test` waits for the package's own `build` only where its tests run that build:
  - the UI (`src/build.test.ts` reads `dist`);
  - the host (its main-process tests load the built `out/main`);
  - the runner (its CLI smoke tests run `dist/cli.js`, and its MCP tests run the relay's
    binary, so it also waits for `@novadeck/relay#build`).
- atlas's extractor reads the built protocol (`extract/protocol.ts` builds it, and the wire
  library it reads as built, when they are missing), so atlas's test and typecheck wait for `@novadeck/protocol#build`, not for a build
  of their own racing turbo's. They are never cached: the extractor reads files across the
  repository that turbo doesn't hash.

## `pnpm test` runs three packages' tests one at a time, and the rest together

`pnpm test` runs every package's tests in parallel but the UI's, the runner's and the host's,
then those three, one at a time. They are the timing-sensitive ones: the UI's browser tests,
the runner's real-PTY tests and the host's real runner. The UI's and the runner's, run
together, starved the smaller CI runners enough to time out. Every other package's tests are
short and run beside each other, so a new package or library adds its time to the parallel
part, not to a serial chain. A package whose tests are as timing-sensitive joins the second
list in the root `package.json`'s `test`.

The three are most of a cold run (here about 200 s for the runner's, 120 s for the UI's), so
this saves little over one package at a time. Running them together too took a cold
`pnpm test` from about 355 s to 230 s on a 22-thread machine, and passed; whether CI's 3- and
4-core runners stand it is what would decide dropping the second list.

## Caching

- **Locally**, turbo caches `build`, `test` and `typecheck` (atlas's excepted, above), in one
  cache all the worktrees share. A second `pnpm test` with nothing changed takes seconds.
- **In CI**, nothing is cached between runs: each job starts on a fresh machine with no turbo
  cache, and gets no remote one. A cached pass there would stand for every input turbo hashes,
  and some tests read what it doesn't (atlas reads the whole repository); a remote cache is
  also a service and a secret to keep. Only Rust's builds and the test browser are cached.
