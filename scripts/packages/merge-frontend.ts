import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { conflictMarkers, mergeManifests } from "./frontend.ts"
import { isText, repository } from "./move.ts"

// What move-frontend.ts does while a merge of main is open on a branch the move already ran
// on: the files the move writes whole exist on both sides (add/add), so git can't tell what
// main changed in them since. This resolves those it can prove safe, from the commit that
// added each on main, and names everything else for a person: it never settles a file it
// can't account for. See scripts/packages/README.md.

/** Whether a merge is open: its MERGE_HEAD, unless that is already in HEAD's history. */
export const mergeHead = (root: string): string | undefined => {
  const { git } = repository(root)
  let head: string
  try {
    head = git("rev-parse", "-q", "--verify", "MERGE_HEAD").trim()
  } catch {
    return undefined
  }
  if (!head) return undefined
  // A MERGE_HEAD left behind once the merge was committed: no merge is open.
  const stale = spawnSync("git", ["merge-base", "--is-ancestor", head, "HEAD"], { cwd: root })
  return stale.status === 0 ? undefined : head
}

/** The tracked text files that hold a conflict marker, as `file:line`. */
export const markersIn = (root: string): string[] => {
  const { read, tracked } = repository(root)
  return [...new Set(tracked())].flatMap((file) => {
    if (!isText(file)) return []
    try {
      return conflictMarkers(read(file)).map((line) => `${file}:${line}`)
    } catch {
      return []
    }
  })
}

const isManifest = (file: string): boolean => /^(?:frontend|apps)\/[^/]+\/package\.json$/.test(file)
const oldManifest = "application/ui/package.json"

/** Resolves what it can of an open merge; gives what is left, for a person. */
export const resolveMerge = (root: string, head: string): { done: string[]; left: string[] } => {
  const { git } = repository(root)
  const show = (spec: string): string => git("show", spec)
  const has = (spec: string): boolean =>
    spawnSync("git", ["cat-file", "-e", spec], { cwd: root, stdio: "ignore" }).status === 0
  const done: string[] = []
  const left: string[] = []

  // Each side's move: the commit that removed the old UI's manifest, and the files it wrote
  // new (added, not moved). What both moves wrote is what the move generates.
  const moveOf = (ref: string): string | undefined =>
    git("log", "-1", "--diff-filter=D", "--format=%H", ref, "--", oldManifest).trim() || undefined
  const branchMove = moveOf("HEAD")
  const mainMove = moveOf(head)
  if (!branchMove || !mainMove)
    return {
      done,
      left: [
        `no move on ${branchMove ? "main's side" : "the branch"}: this is an ordinary merge; resolve it as git says`,
      ],
    }
  const written = (commit: string): Set<string> =>
    new Set(
      git("diff-tree", "-r", "-M", "--diff-filter=A", "--name-only", "--no-commit-id", commit)
        .split("\n")
        .filter(Boolean),
    )
  const branchWrote = written(branchMove)
  const generated = new Set([...written(mainMove)].filter((file) => branchWrote.has(file)))

  // A generated file one side has deleted since its move: git keeps the other side's, as their
  // common base has neither.
  for (const file of generated) {
    const [ours, theirs] = [has(`HEAD:${file}`), has(`${head}:${file}`)]
    if (ours !== theirs)
      left.push(
        `${file}: ${ours ? "main" : "the branch"} deleted it after its move, the other side kept it: git rm it if the deletion stands; to keep it, commit the merge as it is (this step stops asking once the merge is committed)`,
      )
  }

  const stages = new Map<string, Set<number>>()
  for (const entry of git("ls-files", "-u", "-z").split("\0").filter(Boolean)) {
    const [info, file] = entry.split("\t") as [string, string]
    stages.set(file, (stages.get(file) ?? new Set()).add(Number(info.split(" ")[2])))
  }
  const settle = (file: string, text?: string): void => {
    if (text !== undefined) writeFileSync(join(root, file), text)
    git("add", "--", file)
    done.push(file)
  }
  // A file the person has already resolved: no markers, and neither side's text. A rerun leaves
  // it for them to `git add`, rather than write over their work.
  const resolvedByHand = (file: string): boolean => {
    const path = join(root, file)
    if (!existsSync(path)) return false
    const text = readFileSync(path, "utf8")
    return (
      conflictMarkers(text).length === 0 &&
      text !== show(`:2:${file}`) &&
      text !== show(`:3:${file}`)
    )
  }
  // The branch's edits to a file after its move, which main's version doesn't have.
  const editedAfterMove = (file: string): boolean =>
    !has(`${branchMove}:${file}`) || show(`${branchMove}:${file}`) !== show(`:2:${file}`)

  for (const [file, stage] of stages) {
    const addAdd = stage.has(2) && stage.has(3) && !stage.has(1)
    if (file === "pnpm-lock.yaml") {
      // The install after the merge makes it whole; main's is the starting point.
      git("checkout", "--theirs", "--", file)
      settle(file)
    } else if (!addAdd || !generated.has(file)) {
      left.push(
        `${file}: a ${[...stage].join("/")}-stage conflict in a file ${generated.has(file) ? "the move writes, changed on both sides since" : "the move doesn't write"}: resolve it as git says`,
      )
    } else if (resolvedByHand(file)) {
      left.push(`${file}: resolved by hand, it seems: git add it`)
    } else if (isManifest(file) && editedAfterMove(file)) {
      left.push(
        `${file}: the branch changed it after its move (\`git diff ${branchMove.slice(0, 8)} HEAD -- ${file}\`): take main's (\`git checkout --theirs -- ${file}\`), put those changes back by hand, then git add it`,
      )
    } else if (file === "frontend/ui/package.json") {
      // The branch's change to the old manifest, from the fork, onto main's new one.
      const bases = git("merge-base", "--all", "HEAD", head).trim().split("\n").filter(Boolean)
      if (bases.length !== 1) {
        left.push(
          `${file}: the branch and main have ${bases.length} merge bases, so the branch's change to the old manifest isn't one diff: merge it by hand`,
        )
        continue
      }
      try {
        const merged = mergeManifests(
          JSON.parse(show(`${branchMove}^:${oldManifest}`)),
          JSON.parse(show(`${bases[0]}:${oldManifest}`)),
          JSON.parse(show(`:3:${file}`)),
        )
        if (merged.conflicts.length > 0) {
          writeFileSync(join(root, file), merged.text)
          left.push(
            `${file}: both sides changed ${merged.conflicts.join(", ")}: the file holds main's; the branch's are in \`git show ${branchMove.slice(0, 8)}^:${oldManifest}\`: choose, then git add it`,
          )
        } else settle(file, merged.text)
      } catch (error) {
        left.push(
          `${file}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        )
      }
    } else if (isManifest(file)) {
      // Main's; the rerun's union puts back what the branch's imports need.
      git("checkout", "--theirs", "--", file)
      settle(file)
    } else if (!isText(file)) {
      left.push(
        `${file}: both sides wrote it and it isn't text: choose one (git checkout --ours or --theirs)`,
      )
    } else {
      // The branch's against main's, from main's commit that wrote it.
      const added = git("log", "--diff-filter=A", "--format=%H", head, "--", file)
        .trim()
        .split("\n")
        .at(-1)
      if (!added) {
        left.push(`${file}: main has no commit that added it: resolve it by hand`)
        continue
      }
      const dir = mkdtempSync(join(tmpdir(), "merge-frontend-"))
      try {
        const [ours, base, theirs] = [
          show(`:2:${file}`),
          show(`${added}:${file}`),
          show(`:3:${file}`),
        ].map((text, index) => {
          const path = join(dir, String(index))
          writeFileSync(path, text)
          return path
        }) as [string, string, string]
        const merged = spawnSync(
          "git",
          [
            "merge-file",
            "-p",
            "-L",
            "branch",
            "-L",
            "main when it added the file",
            "-L",
            "main",
            ours,
            base,
            theirs,
          ],
          { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 },
        )
        // merge-file gives the count of conflicts; above 127, or a signal, it failed and wrote
        // nothing to take.
        if (merged.status === null || merged.status > 127 || merged.error) {
          left.push(`${file}: git merge-file couldn't merge it: resolve it by hand`)
          continue
        }
        writeFileSync(join(root, file), merged.stdout)
        if (merged.status === 0) settle(file)
        else
          left.push(
            `${file}: both sides changed the same lines: resolve the markers, then git add it`,
          )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
  return { done, left }
}
