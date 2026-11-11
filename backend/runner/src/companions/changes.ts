import { stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import {
  companionLimits,
  hiddenCharacter,
  maxChangesBytes,
  type DiffHunk,
  type ChangedFile,
} from "@novadeck/protocol"

import { git, type Run } from "../checkouts/git.js"
import { cut } from "../text.js"

/** The empty tree a root commit is diffed against, by object format. */
export const emptyTrees = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const
// The raw diff text read: what fits the budget needs hardly more than the budget itself.
export const patchBytes = 2 * maxChangesBytes
// What a line of a change costs beyond its text, once encoded: its kind and punctuation.
const lineOverhead = 30

/** Why a change can't be read: `kind` tells the agent's remedy from the content's reasons. */
export type ChangeFailure = {
  readonly ok: false
  readonly kind: "not-a-repository" | "no-git" | "missing" | "failed"
  readonly reason: string
}

const hidden = new RegExp(hiddenCharacter.source, "gu")
/** A name for display: each invisible or control character shows as U+FFFD, the rest as it is. */
export const displayed = (text: string): string =>
  text.replaceAll(hidden, "\uFFFD").replaceAll(/[\t\n]/g, "\uFFFD")

// One quoted name of git undone: `"a\tb\303\251"` is a name with a tab and bytes.
const unquote = (text: string): string => {
  if (!text.startsWith('"')) return text
  const bytes: number[] = []
  const escapes: { [letter: string]: number } = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 }
  const body = text.slice(1, text.lastIndexOf('"'))
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"))
      continue
    }
    const next = body[index + 1] ?? ""
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1))?.[0]
    if (octal) {
      bytes.push(Number.parseInt(octal, 8))
      index += 3
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0))
      index += 1
    }
  }
  return Buffer.from(bytes).toString("utf8")
}

// The name in a `diff --git` line of a change that names no rename: `a/P b/P`, with the
// prefixes this reader asks git for.
const namesIn = (rest: string): string => {
  if (rest.startsWith('"')) return unquote(/^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0] ?? rest).slice(2)
  return rest.slice(2, 2 + (rest.length - 5) / 2)
}

// Cut to what the protocol takes.
const clipLine = (text: string): string => cut(text, companionLimits.lineLength)

/** What is left of the diff text a change may carry, as encoded: shared by its files. */
export type Budget = { left: number }

const costOf = (text: string): number => Buffer.byteLength(JSON.stringify(text)) + lineOverhead

/** One file of a unified diff: as listed, and its hunks (none where it is binary or `listed`). */
export type ParsedFile = Omit<ChangedFile, "secret" | "reindented"> & {
  /** Its lines passed the budget: it is named, not read. */
  readonly listed: boolean
  readonly hunks: DiffHunk[]
}

const emptyFile = (path: string): ParsedFile => ({
  path,
  oldPath: null,
  status: "modified",
  added: 0,
  removed: 0,
  binary: false,
  listed: false,
  hunks: [],
})

/**
 * The files of a unified diff as git prints it with `--src-prefix=a/ --dst-prefix=b/`
 * (`diff --git` headers, extended headers, hunks): each with its status, rename source,
 * counts and hunks; a binary file with none. A hunk ends by the counts of its header, so a
 * removed line that reads `-- x` is no header. With a `budget`, a file whose lines would
 * pass what is left is `listed` without hunks; `skip` says a file is not wanted (its body
 * is not read at all).
 */
export const parseDiff = (
  text: string,
  options: { readonly budget?: Budget; readonly skip?: (file: ParsedFile) => boolean } = {},
): ParsedFile[] => {
  const { budget, skip } = options
  const files: ParsedFile[] = []
  let file: ParsedFile | undefined
  let spent = 0
  let position = 0
  const next = (): string | undefined => {
    if (position >= text.length) return undefined
    const found = text.indexOf("\n", position)
    const end = found < 0 ? text.length : found
    const line = text.slice(position, end)
    position = end + 1
    return line
  }
  // To the start of the next file's header: a body line always carries a prefix character.
  const skipBody = () => {
    if (text.startsWith("diff --git ", position)) return
    const found = text.indexOf("\ndiff --git ", position)
    position = found < 0 ? text.length : found + 1
  }
  const finish = () => {
    if (!file) return
    if (budget) budget.left -= spent
    files.push(file)
    file = undefined
    spent = 0
  }
  for (let line = next(); line !== undefined; line = next()) {
    if (line.startsWith("diff --git ")) {
      finish()
      file = emptyFile(namesIn(line.slice("diff --git ".length)))
    } else if (!file) {
      continue
    } else if (line.startsWith("new file mode")) {
      file = { ...file, status: "added" }
    } else if (line.startsWith("deleted file mode")) {
      file = { ...file, status: "deleted" }
    } else if (line.startsWith("rename from ")) {
      file = { ...file, status: "renamed", oldPath: unquote(line.slice("rename from ".length)) }
    } else if (line.startsWith("rename to ")) {
      file = { ...file, path: unquote(line.slice("rename to ".length)) }
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file = { ...file, binary: true }
    } else if (line.startsWith("@@ ")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!header) continue
      if (skip?.(file)) {
        skipBody()
        continue
      }
      const oldCount = header[2] === undefined ? 1 : Number(header[2])
      const newCount = header[4] === undefined ? 1 : Number(header[4])
      const hunk = {
        oldStart: Number(header[1]),
        oldCount,
        newStart: Number(header[3]),
        newCount,
        lines: [] as { kind: "context" | "add" | "remove"; text: string }[],
      }
      let old = oldCount
      let now = newCount
      let added = 0
      let removed = 0
      let over = false
      for (let body = next(); body !== undefined; body = next()) {
        const mark = body[0]
        if (mark === "\\") {
          // "\ No newline at end of file": not a line.
        } else {
          const kind = mark === "+" ? "add" : mark === "-" ? "remove" : "context"
          const content = clipLine(body.slice(1))
          if (budget) {
            spent += costOf(content)
            if (spent > budget.left) {
              over = true
              break
            }
          }
          hunk.lines.push({ kind, text: content })
          if (kind !== "remove") now -= 1
          if (kind !== "add") old -= 1
          if (kind === "add") added += 1
          if (kind === "remove") removed += 1
        }
        if (old <= 0 && now <= 0) break
      }
      if (over) {
        // It does not fit: listed by name; what it took goes back for the files after it.
        file = { ...file, listed: true, hunks: [] }
        spent = 0
        skipBody()
        continue
      }
      file = {
        ...file,
        added: file.added + added,
        removed: file.removed + removed,
        hunks: file.listed ? [] : [...file.hunks, hunk],
      }
    }
  }
  finish()
  return files
}

export const failure = (kind: ChangeFailure["kind"], reason: string): ChangeFailure => ({
  ok: false,
  kind,
  reason,
})

/** Why a git run failed, in a sentence: git's own first line where it said one. */
export const reasonOf = (run: Extract<Run, { ok: false }>, doing: string): string => {
  if (run.kind === "no-git") return "Git isn't installed, so changes can't be shown."
  if (run.kind === "timeout") return `Git took too long to ${doing}.`
  if (run.kind === "big") return "The changes are too large to show."
  return `Git couldn't ${doing}${run.said ? `: ${JSON.stringify(run.said)}` : "."}`
}

/**
 * The repository's folder a directory belongs to, or why not: git isn't installed, the
 * directory is gone, it isn't in a work tree, or git refused it (as for a folder another
 * user owns), in git's own words.
 */
export const repositoryOf = async (
  directory: string,
): Promise<{ readonly ok: true; readonly root: string } | ChangeFailure> => {
  const found = await stat(directory).catch(() => undefined)
  if (!found) return failure("missing", "That folder doesn't exist (any more).")
  // A file stands for the folder it is in.
  const top = await git(
    found.isDirectory() ? directory : dirname(directory),
    ["rev-parse", "--show-toplevel"],
    { cap: 64 * 1024 },
  )
  if (top.ok) return { ok: true, root: resolve(top.out.trim()) }
  if (top.kind === "no-git") return failure("no-git", reasonOf(top, "read the changes"))
  if (top.kind === "exit" && /not a git repository/i.test(top.said))
    return failure(
      "not-a-repository",
      "That folder isn't in a git repository, so there are no changes to show. Give " +
        "changes: { path } a folder inside one.",
    )
  return failure("failed", reasonOf(top, "open this folder's repository"))
}

/** Whether two paths name one folder; Windows folds case. */
export const samePlace = (a: string, b: string): boolean =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b)
