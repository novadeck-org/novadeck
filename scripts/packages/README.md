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
   - on a branch that merged the move, a file the branch removed or renamed that came back at
     its new place from main's side, as a rename on the branch against main's move leaves it.
     Delete it with `git rm` if the branch's change stands.
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
6. **It empties each old folder where no tracked file is left.**
   - A file git doesn't track goes to its place in the new folder: a `.env`, or build output
     that a package's own `.gitignore` covers, such as the atlas's `src/generated/`.
   - A build's `dist`, `target` and `.turbo` go where the new folder has none.
   - `node_modules` is deleted, since the install makes it again.
   - A file whose new place already holds a different one stays put. The script names it and
     exits non-zero.
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

If it fails partway, in `git mv`, a write, the carry or the install, it says so with the way
back: `git reset --hard`, delete the new folders where no tracked file is, then run again.

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
git checkout --theirs pnpm-lock.yaml   # the script's install gives the branch's packages back
git add -u && git commit --no-edit     # tracked files only: what git now sees as new at an old
                                       # place stays out, for the script to carry over
node scripts/packages/move-backend.ts
git add -A && git commit -m "chore: catch up with 5.3a's move"
```

The script:

- moves what the branch added at an old place;
- carries what git doesn't track (a `.env`, the atlas's generated files) to the new place;
- rewrites the paths the branch's new lines name;
- installs, so the lockfile is the branch's again.

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
