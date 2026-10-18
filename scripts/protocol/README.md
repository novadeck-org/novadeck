# Moving the runner client out of the protocol

`node scripts/protocol/move-client.ts` moves the protocol's client side into its own package,
`@novadeck/runner-client` in `application/runner-client/`, so the contract can't import it: the
protocol doesn't depend on the new package, and depending on it would be a cycle. Step 5 then only
moves the folder (architecture/step-3-boundaries, 3.3r).

It moves `client.ts` (as the package's `index.ts`), `runner.ts`, `desktop.ts` and `errors.ts` from
`application/protocol/src/`. In the moved files, an import of a file that stays becomes the
protocol's index where that re-exports it, or the protocol's own entry (`@novadeck/protocol/bridge`);
a re-export of a file that stays is dropped, as importers take it from the protocol, and the
protocol's names a file took from several of its files become one import of its index. It stops,
changing nothing, when a moved file imports a file that is neither, when a file that stays imports
one that moves, when the protocol no longer depends on the wire, which the client needs, or when
a package outside its list of consumers (the UI, the host, the runner) imports the client: add it
to `consumers` with the dependency field it needs.

It rewrites, as text in every tracked `.ts`, `.tsx`, `.mts`, `.md`, `.yml` and `.json` file,
`@novadeck/protocol/client` to `@novadeck/runner-client` and the moved files' paths to their new
ones (imports, docs, comments, the atlas's anchors). It writes the package's `package.json` and
copies the protocol's tsconfigs, drops the protocol's `./client` entry, adds the package to the UI's
dependencies and to the host's and the runner's dev dependencies, formats what it touched with
`oxfmt`, and runs `pnpm install` for the lock. It refuses a dirty tree, and refuses to run when
`application/runner-client/` holds tracked files; the ignored `node_modules/` and `dist/` a reset
leaves there don't count.

It ends by listing the mentions it leaves to a person: patterns that name the client's files without
spelling a path out, such as the bench's attribution.

## Redoing the move on a fresh base

1. Cherry-pick the script's commits (`git log --oneline -- scripts/protocol`).
2. Run `CI=true node scripts/protocol/move-client.ts` on a clean tree and commit its output.
3. Cherry-pick every commit after the script's run, oldest first: the rules, the docs, and the
   host's smoke check, which named the client's built file by path segments the rewrite
   doesn't read and now resolves the package.
