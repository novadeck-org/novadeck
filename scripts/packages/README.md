# Moving the backend into its packages

`node scripts/packages/move-backend.ts` is step 5's 5.3a, the first of the architecture
plan's package moves. It moves:

| From                        | To                       |
| --------------------------- | ------------------------ |
| `application/runner`        | `backend/runner`         |
| `application/relay`         | `backend/relay`          |
| `application/protocol`      | `contract/protocol`      |
| `application/runner-client` | `contract/runner-client` |
| `atlas`                     | `tools/atlas`            |

It then points every mention of those folders at the new place. The table and the rewrite are
in `backend.ts`, and `backend.test.ts` tests them on text.

**It makes the tree so rather than doing a move.** Every step looks first:

- It moves the tracked files it finds at an old place. On main that is all of them. On a
  branch that merged main after the move, it is the files the branch added there.
- It rewrites the mentions it finds of an old folder.
- It makes each handwritten edit whose old text it finds. An edit is done once that text is
  gone, so neither a second run nor a run after 5.3b or 5.3c has rewritten the line stops on
  it.

So the same command does the move on main and brings an unfinished branch up to it. Run on a
tree with nothing to do, it says so and changes nothing.

## What it does

1. **It refuses a dirty tree, and a tree where `oxfmt` can't run.** It takes `oxfmt` from
   `node_modules/.bin`, since `pnpm exec` refuses once the manifests change. Files git doesn't
   track are allowed at the old places. A merge that moved a package's `.gitignore` leaves
   them there, and the script carries them over (step 6).
2. **It plans everything before writing.** It stops with nothing changed on any of these:
   - a file tracked at both an old place and its new one;
   - a tracked file that its package ignores as build output, at either place;
   - a destination that no glob in `pnpm-workspace.yaml` takes in;
   - a handwritten edit that finds its old text more than once;
   - right after the merge that brought the move in: a file the branch removed or renamed that
     came back at its new place from main's side. That's what a rename on the branch against
     main's move leaves. For a rename, `git rm` the copy that doesn't stand. For a deletion,
     `git rm` main's copy, or keep it with any commit; an empty one says so. The check runs
     only while the merge is the last commit, so a commit settles it either way.
3. **It moves each tracked file** with `git mv`, folders kept.
4. **It rewrites paths as text,** in every tracked text file except those in `kept` (see
   below), with these rules:
   - A path from the repository's root is rewritten wherever it is written: after a space, a
     quote, a backtick, a bracket, `=`, `:` or `,`, and before its next segment, its end, a
     markdown anchor or a query. Not before a `.` or a `*`: `application/runner.ts` is another
     file, and `application/runner*` a glob that also took the runner client, which moves
     elsewhere. The leftover scan shows both, for a person to decide.
   - So is a relative path (`./`, `../../`). Both ends keep their depth: `application/x` and
     `backend/x` sit equally deep.
   - So is a regular expression's escaped form (`\/application\/protocol\/`).
   - The atlas moves one folder deeper, so it is matched only from the root, and only where a
     segment follows. The atlas's own `atlas-data.ts`, a glyph atlas, and a fence's
     `**/../atlas` are left as they are.
   - Something like `/w/repo/application/runner`, a path inside an absolute one, is no path
     from the root and is left as it is.
5. **It makes the handwritten edits** in `edits`, each with its reason:
   - the workspace's `atlas` line;
   - `electron-builder.yml`'s `from: ../relay/dist`, a path from the host, one level deeper;
   - the benchmark's folder alternation, which gains the runner client the UI imports, and the
     bench attribution's regex and its sample stack paths;
   - dependabot's `/application/relay`;
   - the README map's first sentence, its sentence on `tools/`, and its atlas row.
6. **It empties each old folder where no tracked file is left,** after the install, so a
   failure before it has touched nothing git doesn't track.
   - A file git doesn't track goes to its place in the new folder: a `.env`, or build output
     that a package's own `.gitignore` covers, such as the atlas's `src/generated/`.
   - A build's `dist`, `target` and `.turbo` go where the new folder has none.
   - `node_modules` is deleted, since the install makes it again.
   - A file whose new place already holds a different one stays put. The script names it and
     exits non-zero. A symbolic link moves as a link.
   - A carried text file is rewritten as the tracked ones were: a branch's work in progress
     names old paths too.
7. **It runs `pnpm install --no-frozen-lockfile`** with `CI=true`, on every run. The lockfile
   names each package by its folder, and a catch-up may have taken main's lockfile. Then it
   runs `oxfmt` on what it wrote, which also re-pads the README's table.
8. **It lists any mention of an old folder left anywhere outside `kept`.** That means any
   mention in any form:
   - segments joined with either quote (`"application", "runner"`);
   - in an alternation, a brace glob, or a glob or template over `application/`;
   - a relative path that lands at an old folder from its file's own folder (`../relay/dist`
     in the host's config), or that leaves the atlas at the depth it had;
   - the atlas with a backslash, negated, entered with `cd`, joined, or in a URL.

   This is also what shows a handwritten edit left unmade where a branch changed the line it
   looks for. Such an edit is reported as having nothing to do, along with any edit whose file
   is gone. If any mention is left, the script exits non-zero.

If it fails partway, in `git mv`, a write or the install, it says so with the way back:
`git reset --hard && git clean -fd backend contract tools/atlas`, then run again. `git clean -fd`
keeps what git ignores, such as a `.env` made at a new place. Nothing git doesn't track has
moved by then. If the carry fails, the move is done, and the script says to move what is left
at the old places by hand.

`kept` covers what names an old folder on purpose:

- the lockfile;
- CI logs captured as fixtures;
- the flaky reports;
- the earlier move scripts;
- the tests whose path strings are sample input;
- this folder.

## Catching up a branch after the move

For a branch made before 5.3a, such as a step-2 or step-4 slice, or 3.3r if it waited:

```
git merge origin/main
# Conflicts: a file the branch changed and main moved usually merges at its new place, by
# rename detection. For a modify/delete conflict, or a file left in a folder main renamed,
# keep the branch's content at the new place.
# A clean merge commits itself: skip the next two lines. If it stopped on conflicts:
git checkout --theirs pnpm-lock.yaml   # the script's install gives the branch's packages back
git add -u && git commit --no-edit     # tracked files only: what git now sees as new at an old
                                       # place stays out, for the script to carry over; a file
                                       # you placed at a new place by hand needs its own git add
node scripts/packages/move-backend.ts
git add -A && (git diff --cached --quiet || git commit -m "chore: catch up with 5.3a's move")
```

The last line commits only if the script changed what git tracks: a run that carried ignored
files alone (a `.env`, the atlas's generated JSON) leaves nothing to commit.

The script:

- moves what the branch added at an old place;
- carries what git doesn't track (a `.env`, the atlas's generated files) to the new place. A
  carried text file that names an old path is rewritten too, so "rewriting 1" can be the
  atlas's ignored JSON;
- rewrites the paths the branch's new lines name;
- installs, so the lockfile is the branch's again, and says so when that is all it did.

If it stops on a plan problem, fix that and commit. If it lists a mention left over, fix that
line by hand and commit it. Then run the script again, which should say there is nothing to do.

## What to check after

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.
- The relay's own tests: `cargo test --locked`, from `backend/relay`.
- The atlas: `pnpm atlas` builds it, and `node tools/atlas/extract/main.ts` reads the tree.
- On the pull request:
  - e2e on all three systems;
  - the packaging run, which packages the relay and the runner from their new places.
- A second run of the script says there is nothing to do.

# Moving the frontend into its packages

`node scripts/packages/move-frontend.ts` is step 5's 5.3b
([step 5](../../architecture/step-5-packages/README.md), the
[inventory](../../tasks/arch-step-5/5.3b-inventory.md)). It splits `application/ui` into eight
packages and two apps. The table and the rewrite are in `frontend.ts`, and `frontend.test.ts`
tests them on text and on a small tree; it shares `move.ts` with `move-backend.ts`.

| From (below `application/ui/`)                                                        | To                                                        |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `src/core/`                                                                           | `frontend/core` (`@novadeck/core`)                        |
| `src/test/fixtures.ts`                                                                | `frontend/core/src/testing.ts` (the `./testing` export)   |
| `src/test/{render,phases,backend-contract}`                                           | `frontend/test-kit`                                       |
| `src/backend/terminal-views/`                                                         | `frontend/terminal-views`                                 |
| `src/backend/runner/`                                                                 | `frontend/runner-adapter`                                 |
| `src/backend/demo/` without `debug/`                                                  | `frontend/demo`                                           |
| `src/backend/demo/debug/`                                                             | `frontend/demo-debug`                                     |
| `src/specs/`                                                                          | `frontend/specs`                                          |
| `src/entries/{try,previews}.tsx`, their pages, `scripts/poster.ts`, `src/deploy*`     | `apps/try`, `apps/previews` (`src/main.tsx` is the entry) |
| `src/bundle-boundary*`                                                                | `tools/build-kit/src/bundle-checks*`                      |
| the rest (the app's layers, `styles.css`, `public/`, the desktop and browser entries) | `frontend/ui` (`@novadeck/ui`, the name kept)             |

Like `move-backend.ts` it **makes the tree so rather than doing a move**: it moves the tracked
files it finds at an old place, rewrites the imports and paths it finds that name one, makes each
handwritten edit or finds it made, and on a tree with nothing to do says so and changes nothing.

## What it does

1. **It refuses a dirty tree, and plans everything before writing.** It stops with "Stopped,
   nothing changed" on any problem below, and writes nothing.
2. **It rewrites every import** (`from`, `import()`, a bare `import`, `vi.mock` and the other
   Vitest module calls, a stylesheet's `@import`) by resolving the specifier to a file, finding
   that file's package after the move, and writing what reaches it:
   - `#core/x` and every relative import that crosses into another package become
     `@novadeck/<package>/<subpath>`; `index` is the package itself;
   - inside a package a relative import is recomputed from the new places, and stays as it was
     where both ends moved together;
   - the one-line Vitest re-export, `src/test.ts`, is each package's own (decision 1): an
     import of it points at the file's package's copy, which the run writes. Moving it into the
     test kit would close a cycle (core's tests, test-kit, core);
   - a specifier it can't place (names no file, a file the move deletes, a file in no package) is
     a problem, as is an npm package no `package.json` in the repository gives a version.
     Import lines that are sample code in strings, in the demo's showcase and transcripts (`samples`
     in `frontend.ts`), may name files that don't exist and are left as they are.
3. **It derives the packages' manifests from those imports** (F8): `dependencies` from what
   the package's source imports, `devDependencies` from what its tests, configs and scripts import
   and from the build tools; workspace packages as `workspace:*`, npm packages at the version the
   repository already gives (the old UI's, or the root's). The `exports` are the package's own
   (`frontend.ts`'s table) plus one subpath for each file another package imports: for the UI that
   is what the apps start from and what the specs reach (decision 3), and its architecture test checks
   that only the specs import what isn't public. A rerun brings only `exports` and the two dependency
   lists of an existing manifest up to date.
4. **It checks the packages' graph has no cycle,** dev dependencies included, as turbo counts them.
5. **It writes whole the files that can't be moved with their imports pointed elsewhere,** from
   templates in `frontend/` beside the script (the destination's path, plus `.tmpl`): the UI's
   `vite.config.ts` (the desktop and browser builds), the two apps' configs, the specs' Vitest
   projects, the UI's, the core's and the apps' architecture and deploy tests, `bundle-checks`,
   `vitest.ts` and `tailwind-guards.test.ts` in the build kit. A file that replaces another is replaced only while the
   other is the text the template was written for (its hash is in `made`); a branch that changed it
   stops the run, naming the file, for the template to be redone. A file with no hash is new and made
   only if it isn't there.
6. **It generates** each package's `tsconfig.json` and `vitest.config.ts` (unit tests, and for the terminal
   views and the demo the one browser spec each keeps, decision 4), if they aren't there.
7. **It makes the handwritten edits** in `edits`, each with its reason: the host's `from:`, the root
   scripts (the apps' own filters and modes, the serial test list and the two shards'), the library fences, the five
   workflows' Playwright filter (the specs own it, decision 5), try's workflow (it picks the app's `dist`
   and its Playwright package by layout, so an older tag still deploys), the build kit's exports, the
   profile and README text, and `styles.css`: Tailwind scans the UI's package and each package whose markup
   it renders (`source(none)` and an `@source` line each, tests left out), so every build's CSS is what it
   was. The build checks guard a utility from the demo's and the debug panel's folders, written in
   halves in the build kit, and `tailwind-guards.test.ts` fails if any file Tailwind scans outside the
   guarded folder holds one whole.
8. **It points paths named in text at the new place** (`application/ui/src/<x>` and `ui/src/<x>`,
   the specs' outputs `test-results/` and `.vitest/`), in every tracked text file except those in
   `kept`.
9. **It runs `pnpm install --no-frozen-lockfile`,** then `oxfmt` on what it wrote, as `move-backend.ts`
   does, and **lists any mention of the old UI** left outside `kept`, exiting non-zero if there is
   one. It also names `application/ui` while only ignored files (`node_modules`, `dist`) are left there.

`kept` covers what names the old UI on purpose: the lockfile, the CI fixtures and reports, the earlier
move scripts, the try workflow's old layout, and the tests whose paths are sample input.

## Catching up a branch after the move

For a branch that edits or adds files below `application/ui`, made before 5.3b. **Run the
script on the branch first, then merge main**: the branch's files are all still at their old
places, so every import is rewritten and the replaced-file guard (below) sees the branch's edits.
Merged first, git moves the branch's new files to their new places with their old specifiers, and
a replaced file the branch edited lands at its new place un-rewritten.

```
git fetch origin
git checkout origin/main -- scripts/packages    # the script and its templates, if the branch lacks them
git add scripts/packages && git commit -m "chore: the move scripts, from main"
node scripts/packages/move-frontend.ts
git add -A && (git diff --cached --quiet || git commit -m "chore: 5.3b's move, on the branch")
git merge origin/main                           # a clean merge commits itself: skip the next two lines
node scripts/packages/move-frontend.ts          # while the merge is open: see below
git add -u && git commit --no-edit
node scripts/packages/move-frontend.ts          # nothing to do, or what main added at an old place
```

The files the move writes whole exist on both sides, so git reports them as added on both and
can't tell what main changed in them since. **Run during the open merge, the script resolves
them** (it finds the merge by `MERGE_HEAD`), each from the commit that added it on main:

- `frontend/ui/package.json`: main's file, with the branch's change to the old
  `application/ui/package.json` (against the one at the fork) merged into it key by key, one level
  into scripts and dependencies. A key both sides changed differently is named, and left for you.
- The other `package.json` files of the packages and apps: main's. The next run puts back the
  exports and dependencies the branch's imports need.
- The configs, the tsconfigs and the other generated files: `git merge-file` with the file as main's
  commit that added it had it as the base, so the branch's edit and main's both stay. Where both
  changed the same lines, the markers are left in the file and named.
- `pnpm-lock.yaml`: main's; the install after the commit makes it whole.

It resolves only what it can prove safe, and names everything else, never settling a file it
can't account for:

- **Only files both moves wrote are its to merge.** These are the files main's move commit and
  the branch's added new. Any other add/add, or a conflict with a base, is git's, and is left to
  you.
- **A manifest the branch changed after its move** is left for you, with the diff to put back
  onto main's. A generated config both sides changed is merged by `git merge-file`, and left
  for you only where both changed the same lines. Resolve it, or take a side with
  `git checkout --ours` or `--theirs`, then `git add` it at once: a rerun merges a file that is
  still unmerged again.
- **A generated file one side deleted after its move**, which git would bring back from the
  other side, is named. Commit the merge as it is to keep it.
- **A file that isn't text** is left for you to choose a side.
- **A file you have resolved by hand,** with no markers and neither side's text, is left for you
  to `git add`. A second run doesn't write over it.
- **More than one merge base** (criss-cross history) leaves the old manifest's change to you.
- **A `MERGE_HEAD` already in HEAD's history**, left after the merge was committed, doesn't count
  as an open merge.

**The root `package.json` conflicts on the `test` line** even on a branch that never edited it.
The branch's run wrote the serial list as the move first had it, and main has changed it since
(#315 runs every package of `frontend/` and `apps/` one at a time). This conflict is git's, so
the script leaves it to you. Where the branch didn't edit the line, take main's side of that
hunk. Where it did, put its change onto main's line. If main changes these root test lines
again, the script lists them under "Handwritten edits with nothing to do" until their
`settled` forms in `frontend.ts` are updated.

It then lists what is left, and any conflict marker in the tree; fix those, `git add` them, and run
it again. **It will not run on a tree with a conflict marker in a tracked text file**, merge or not,
so unresolved lines can't be committed.

The first run also rewrites the imports and paths the branch's lines name (`#core/x` becomes
`@novadeck/core/x`, or `./x` inside the core), moves what the branch added at an old place, and
carries what git doesn't track there (a `.env.local`) to `frontend/ui`. It keeps what the branch
changed in the old UI's `package.json` against main's: a script it added or whose command it
changed, a dependency it added or whose version it bumped, an `imports` entry it added (the rest
of that file is generated from the imports). A field it has no place for, or a replaced file the
branch edited (the UI's `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`,
`architecture.test.ts`, `deploy.test.ts`, `bundle-boundary*`), stops it with a message naming the
file: make the branch's change in the file's template under `scripts/packages/frontend/` (or the
generator in `frontend.ts` for `tsconfig.json` and `vitest.config.ts`) and its hash in `made`, or
by hand after the move. A glob, a URL made from `import.meta.url` or a stylesheet's `url()` that
reaches another package stops it too: no rewrite could choose how. Comments that look like imports
are rewritten with the code.

## What to check after

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.
- The four UI builds: `pnpm --filter @novadeck/ui build`, `pnpm --filter @novadeck/ui build --mode web`,
  `pnpm build:try` (with `pnpm poster:try`) and `pnpm --filter @novadeck/previews build`. Each runs the
  shared build checks, and the visitor build its budgets.
- On the pull request: e2e on all three systems, the packaging run (it copies `frontend/ui/dist`), and
  the try workflow's build.
- A second run of the script says there is nothing to do.

# Moving the desktop app into apps/desktop

`node scripts/packages/move-desktop.ts` is step 5's 5.3c, after 5.3a and 5.3b. It moves the host
into `apps/desktop`, with the two pages it serves, which leave the UI for a build of the app's
own. Its table and rewrite are in `desktop.ts`, and its templates in `desktop/`. It shares
`move.ts` with the backend's move, and works like it. It makes the tree so, it carries what git
doesn't track, it installs on every run, and a second run says there is nothing to do.

| From                                  | To                                          |
| ------------------------------------- | ------------------------------------------- |
| `application/host`                    | `apps/desktop`                              |
| `frontend/ui/index.html`              | `apps/desktop/renderer/index.html`          |
| `frontend/ui/src/entries/desktop.tsx` | `apps/desktop/renderer/main.tsx`            |
| `frontend/ui/entries/web/index.html`  | `apps/desktop/renderer/web/index.html`      |
| `frontend/ui/src/entries/web.tsx`     | `apps/desktop/renderer/web/main.tsx`        |
| `frontend/ui/src/build.test.ts`       | `apps/desktop/src/build.test.ts`            |
| `frontend/ui/entries/web/main.tsx`    | (deleted: a page's script is its entry now) |
| `frontend/ui/vite.config.ts`          | (deleted: the app builds its pages)         |

## What it does

1. **It refuses a tree with a conflict marker in a tracked file, and plans everything before
   writing.** It stops with "Stopped, nothing changed" on any problem below.
2. **It moves the files.** A deleted one goes with `git rm`.
3. **It rewrites the host's folder and each page's old path as text,** with the same bounds as
   the backend's move.
4. **It makes the handwritten edits** in `edits`, each guarded and done once its old text is
   gone:
   - the entries import the UI by its package's subpaths, as `apps/try`'s do;
   - the desktop page's script is `/main.tsx`, from its folder, so the two pages differ and git
     pairs each with its own old page;
   - `electron-builder.yml` copies the app's own `dist`;
   - the app's `dev`, `build` and `typecheck` cover its pages;
   - `dev:web` and the timing bench serve and build the web page from the app, and the profile
     bench builds the desktop page from it;
   - the README, the theming doc, the atlas's UI entry and the dev-web test follow;
   - the UI's architecture test (the runner adapter's entries) and the browser fence, which
     takes `apps/desktop/renderer` and leaves the app's `src/`, Node's;
   - the build kit's `desktopUtilities`: the renderer's build guards the UI's own folder too, as
     its config is outside it, and the guards' test keeps that utility unique.
5. **On the run that moves the host alone** (while its `package.json` is at the old place), it
   makes what the move makes once. A later run, on a branch catching up, undoes nothing main
   changed since:
   - it deletes `frontend/ui/vite.config.ts` and `entries/web/main.tsx`;
   - it removes the pages' lines from the UI's tsconfig (`onTheMove`);
   - it cuts two of the UI's tests that leave with the pages: the pages' scripts, and the SVG
     filters the page carries. The app's `page.test.ts` checks both;
   - it changes the manifests. The app takes the pages' packages, at the UI's versions, and the
     UI drops the runner adapter and its `dev`, `build` and `preview` scripts;
   - it writes the app's files from `desktop/` (`templates`): `vite.config.ts`, the pages' build
     (`renderer/` to `dist/`, mode `web` to `dist-web/`, on port 5173), `vitest.config.ts`,
     `renderer/tsconfig.json` and `src/page.test.ts`, each only where nothing is; and
     `src/packaging.test.ts`, over the host's only while it is the text the template was written
     for (its hash in `was`, which `desktop.test.ts` checks against the host's file until the
     move). A file the branch changed stops the run, naming it, for the template to be redone.
6. **On a branch whose last commit merged main's move,** it names what the branch renamed or
   deleted that came back at the new place, as the backend's move does, and stops.
7. **It installs, formats, carries and scans for leftovers,** as the backend's move does.
   This includes `--filter @novadeck/ui dev|build|preview` and the UI's old page paths. Then
   `application/` goes, once nothing is left in it. Its `pnpm-workspace.yaml` glob, the fence's
   `application/` patterns and the libraries scripts' folder lists went in 5.4.

## Catching up a branch after the move

For a branch made before 5.3c, the backend's recipe above, with `move-desktop.ts`:

- **Merge main first, then run the script.** The branch's changes to the host merge at its new
  place by rename detection, as do its changes to either page.
- **`frontend/ui/vite.config.ts` and `frontend/ui/entries/web/main.tsx`** are deleted on main,
  so a branch that changed one has a modify/delete conflict: make the change in
  `apps/desktop/vite.config.ts` or `apps/desktop/renderer/web/main.tsx`, then `git rm` the old
  file. One kept from the branch's side (`git add -u`) stops the script on that merge, naming
  both.
- **A rename or a deletion of the branch's that main's move brought back** stops the script,
  naming both files: `git rm` the one that doesn't stand, and commit, or commit anything to keep
  main's.
- **The recovery** adds `git clean -fd apps/desktop`.

## What to check after

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.
- `pnpm --filter @novadeck/host build`, which builds `dist/` (the page) and `out/` (the main
  process).
- On the pull request: the packaging run on all three systems with signing, the smoke test, the
  try deploy and previews.
- By hand, once: `pnpm dev`, which shows the desktop window and needs a display, and
  `pnpm dev:web`.
