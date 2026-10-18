import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { conflictMarkers, mergeManifests } from "./frontend.ts"
import { isText, repository } from "./move.ts"

// What move-frontend.ts does while a merge of main is open on a branch the move already ran
// on: the files the move writes whole exist on both sides (add/add), so git can't tell what
// main changed in them since. This resolves them, from the commit that added each on main,
// and names what is left for a person. See scripts/packages/README.md.

/** Whether a merge is open: its MERGE_HEAD. */
export const mergeHead = (root: string): string | undefined => {
  try {
    return repository(root).git("rev-parse", "-q", "--verify", "MERGE_HEAD").trim() || undefined
  } catch {
    return undefined
  }
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

/** Resolves what it can of an open merge; gives what is left, for a person. */
export const resolveMerge = (root: string, head: string): { done: string[]; left: string[] } => {
  const { git } = repository(root)
  const show = (spec: string): string => git("show", spec)
  const stages = new Map<string, Set<number>>()
  for (const entry of git("ls-files", "-u", "-z").split("\0").filter(Boolean)) {
    const [info, file] = entry.split("\t") as [string, string]
    stages.set(file, (stages.get(file) ?? new Set()).add(Number(info.split(" ")[2])))
  }
  const done: string[] = []
  const left: string[] = []
  const settle = (file: string, text?: string): void => {
    if (text !== undefined) writeFileSync(join(root, file), text)
    git("add", "--", file)
    done.push(file)
  }
  for (const [file, has] of stages) {
    const addAdd = has.has(2) && has.has(3) && !has.has(1)
    if (file === "pnpm-lock.yaml") {
      // The install after the merge makes it whole; main's is the starting point.
      git("checkout", "--theirs", "--", file)
      settle(file)
    } else if (addAdd && file === "frontend/ui/package.json") {
      // The branch's change to the old manifest, against the one at the fork, onto main's new one.
      try {
        const moved = git(
          "log",
          "-1",
          "--format=%H",
          "HEAD",
          "--",
          "application/ui/package.json",
        ).trim()
        const fork = git("merge-base", "HEAD", head).trim()
        const merged = mergeManifests(
          JSON.parse(show(`${moved}^:application/ui/package.json`)),
          JSON.parse(show(`${fork}:application/ui/package.json`)),
          JSON.parse(show(":3:frontend/ui/package.json")),
        )
        writeFileSync(join(root, file), merged.text)
        if (merged.conflicts.length > 0)
          left.push(
            `${file}: both sides changed ${merged.conflicts.join(", ")}: choose in the file, then git add it`,
          )
        else settle(file)
      } catch (error) {
        left.push(
          `${file}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        )
      }
    } else if (addAdd && isManifest(file)) {
      // Main's; the rerun's union puts back what the branch's imports need.
      git("checkout", "--theirs", "--", file)
      settle(file)
    } else if (addAdd) {
      const added = git("log", "--diff-filter=A", "--format=%H", head, "--", file)
        .trim()
        .split("\n")
        .at(-1)
      if (!added) {
        left.push(`${file}: main has no commit that added it`)
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
          {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 1 << 26,
          },
        )
        writeFileSync(join(root, file), merged.stdout)
        if (merged.status === 0) settle(file)
        else
          left.push(
            `${file}: both sides changed the same lines: resolve the markers, then git add it`,
          )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } else left.push(`${file}: ${[...has].join("/")}-way conflict, not a file the move writes`)
  }
  return { done, left }
}
