import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { previewLimits, type PreviewHunk } from "@novadeck/protocol"

import { git } from "../checkouts/git.js"

// A file as one work carries it onto main's copy: git's three-way merge of the file at the
// merge base, on main and in the worktree, then the lines main's copy differs from the merge
// by, in main's own line numbers.

const big = { cap: 2 * previewLimits.text }
const diffCap = { cap: 8 * 1024 * 1024 }

/** A file's text at `spec` (`<rev>:<path>`), null where it has none there; undefined where git failed. */
export const textAt = async (
  root: string,
  spec: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null | undefined> => {
  const run = await git(root, ["cat-file", "blob", spec], env ? { ...big, env } : big)
  if (run.ok) return run.out
  // A path or revision git doesn't know is no file; a timeout or a file too large is no answer.
  return run.kind === "exit" ? null : undefined
}

const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/

/** The hunks of `git diff -U0`, as main's line numbers: a hunk of the old file's lines and the new ones. */
export const hunksOf = (diff: string): Omit<PreviewHunk, "applies">[] => {
  const hunks: { at: number; removed: number; lines: string[] }[] = []
  for (const line of diff.split("\n")) {
    const found = header.exec(line)
    if (found) {
      const start = Number(found[1])
      const count = found[2] === undefined ? 1 : Number(found[2])
      hunks.push({ at: count === 0 ? start + 1 : start, removed: count, lines: [] })
    } else if (line.startsWith("+") && hunks.length > 0) hunks.at(-1)!.lines.push(line.slice(1))
  }
  return hunks
}

const same = (a: Omit<PreviewHunk, "applies">, b: Omit<PreviewHunk, "applies">): boolean =>
  a.at === b.at && a.removed === b.removed && a.lines.join("\n") === b.lines.join("\n")

// Whether two hunks touch one another's lines of main, or sit side by side.
const touching = (a: Omit<PreviewHunk, "applies">, b: Omit<PreviewHunk, "applies">): boolean =>
  a.at <= b.at + b.removed && b.at <= a.at + a.removed

/**
 * What carrying `theirs` (the worktree's file) onto `main`, from their common ancestor `base`,
 * does to main's lines: each hunk that merges cleanly, and each that doesn't (main has
 * rewritten the lines it changed), told by merging once taking main's side at a conflict and
 * once the worktree's, and keeping the hunks only the second has. Texts are "" where a file is
 * missing. Undefined where git failed.
 */
export const carry = async (
  root: string,
  { main, base, theirs }: { main: string; base: string; theirs: string },
): Promise<PreviewHunk[] | undefined> => {
  const folder = await mkdtemp(join(tmpdir(), "novadeck-preview-"))
  try {
    const files = {
      main: join(folder, "main"),
      base: join(folder, "base"),
      theirs: join(folder, "theirs"),
    }
    await Promise.all([
      writeFile(files.main, main),
      writeFile(files.base, base),
      writeFile(files.theirs, theirs),
    ])
    const merged = async (side: "ours" | "theirs", name: string): Promise<string | undefined> => {
      const run = await git(
        root,
        ["merge-file", "-p", `--${side}`, files.main, files.base, files.theirs],
        diffCap,
      )
      if (!run.ok) return undefined
      await writeFile(join(folder, name), run.out)
      return run.out
    }
    const [applied, wanted] = [await merged("ours", "applied"), await merged("theirs", "wanted")]
    if (applied === undefined || wanted === undefined) return undefined
    const diff = async (name: string) => {
      const run = await git(
        root,
        [
          "diff",
          "--no-index",
          "--no-color",
          "--no-ext-diff",
          "-U0",
          files.main,
          join(folder, name),
        ],
        diffCap,
      )
      // Differing files exit 1.
      const out = run.ok ? run.out : run.kind === "exit" && run.status === 1 ? run.out : undefined
      return out === undefined ? undefined : hunksOf(out)
    }
    const clean = await diff("applied")
    if (clean === undefined) return undefined
    if (applied === wanted) return clean.map((hunk) => ({ ...hunk, applies: true }))
    const all = await diff("wanted")
    if (all === undefined) return undefined
    // A hunk only the worktree's side has is where main's lines stand in for it; the clean
    // hunks it runs into were merged with it, so they go with it.
    const lost = all.filter((hunk) => !clean.some((each) => same(each, hunk)))
    return [
      ...clean
        .filter((hunk) => !lost.some((each) => touching(hunk, each)))
        .map((hunk) => ({ ...hunk, applies: true })),
      ...lost.map((hunk) => ({ ...hunk, applies: false })),
    ].toSorted((a, b) => a.at - b.at)
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}
