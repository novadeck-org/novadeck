import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { lstat, open, readlink, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import {
  maxChangedFiles,
  maxChangesBytes,
  type ChangedFile,
  type ItemContent,
} from "@novadeck/protocol"

import { hashOf } from "./content.js"
import { secret } from "./secrets.js"

/** The empty tree, which a repository with no commit yet is diffed against. */
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
/** What one git run may take, and print, before it is given up on. */
const gitMs = 5_000
const gitBytes = 64 * 1024 * 1024
// A line is cut to what the protocol takes; a text file has no NUL byte in this much of its start.
const maxLineChars = 4096
const sniffBytes = 8 * 1024
// The largest untracked file read to show as added; a larger one is listed by name.
const maxUntrackedBytes = 1024 * 1024

/** A change as read: what `companions.content` carries, and its whole size before bounds. */
export type Change = {
  readonly root: string
  readonly base: string
  readonly files: readonly ChangedFile[]
  readonly truncated: boolean
  /** How many files changed in all, and their added and removed lines, whatever was cut. */
  readonly total: { readonly files: number; readonly added: number; readonly removed: number }
}

/** Why a change can't be read: `kind` tells the agent's remedy from the content's reasons. */
export type ChangeFailure = {
  readonly ok: false
  readonly kind: "not-a-repository" | "no-git" | "missing" | "failed"
  readonly reason: string
}

type Run =
  | { readonly ok: true; readonly out: string }
  | { readonly ok: false; readonly code: string }

// Runs git as the person would, with no shell and a fixed argument list; optional locks are
// off so looking never takes the index lock the agent's own git needs, and nothing prompts.
// A repository's `core.fsmonitor` hook is switched off: reading must not run programs.
const git = (cwd: string, args: readonly string[]): Promise<Run> =>
  new Promise((done) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        timeout: gitMs,
        killSignal: "SIGKILL",
        maxBuffer: gitBytes,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (!error) return done({ ok: true, out: stdout })
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT") return done({ ok: false, code: "ENOENT" })
        if (error.killed) return done({ ok: false, code: "timeout" })
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return done({ ok: false, code: "big" })
        const said = stderr.split("\n")[0]?.trim() ?? ""
        done({
          ok: false,
          code: `exit:${typeof code === "number" ? code : "?"}:${said.slice(0, 200)}`,
        })
      },
    )
  })

// One line of git's C-style quoting undone: `"a\tb\303\251"` is a name with a tab and bytes.
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

// The two names in a `diff --git` line, for a change that names no rename: `a/P b/P`.
const namesIn = (rest: string): string => {
  if (rest.startsWith('"')) return unquote(/^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0] ?? rest).slice(2)
  return rest.slice(2, 2 + (rest.length - 5) / 2)
}

const clipLine = (text: string): string => text.slice(0, maxLineChars)

const emptyFile = (path: string): ChangedFile => ({
  path,
  oldPath: null,
  status: "modified",
  added: 0,
  removed: 0,
  binary: false,
  held: false,
  listed: false,
  hunks: [],
})

/**
 * The files of a unified diff as git prints it (`diff --git` headers, extended headers,
 * hunks): each with its status, rename source, counts and hunks; a binary file with none.
 * A hunk ends by the counts of its header, so a removed line that reads `-- x` is no header.
 */
export const parseDiff = (text: string): ChangedFile[] => {
  const files: ChangedFile[] = []
  let file: ChangedFile | undefined
  const lines = text.split("\n")
  const push = () => {
    if (file) files.push(file)
  }
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!
    if (line.startsWith("diff --git ")) {
      push()
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
      const oldStart = Number(header[1])
      const oldCount = header[2] === undefined ? 1 : Number(header[2])
      const newStart = Number(header[3])
      const newCount = header[4] === undefined ? 1 : Number(header[4])
      const hunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [] as { kind: "context" | "add" | "remove"; text: string }[],
      }
      let old = oldCount
      let added = 0
      let removed = 0
      let now = newCount
      while ((old > 0 || now > 0) && at + 1 < lines.length) {
        at += 1
        const body = lines[at]!
        const mark = body[0]
        if (mark === "+") {
          hunk.lines.push({ kind: "add", text: clipLine(body.slice(1)) })
          now -= 1
          added += 1
        } else if (mark === "-") {
          hunk.lines.push({ kind: "remove", text: clipLine(body.slice(1)) })
          old -= 1
          removed += 1
        } else if (mark === "\\") {
          // "\ No newline at end of file": not a line.
        } else {
          hunk.lines.push({ kind: "context", text: clipLine(body.slice(1)) })
          old -= 1
          now -= 1
        }
      }
      file = {
        ...file,
        added: file.added + added,
        removed: file.removed + removed,
        hunks: [...file.hunks, hunk],
      }
    }
  }
  push()
  return files
}

/** A new file as all-added lines, as git would diff it against nothing. */
const addedFile = (path: string, text: string): ChangedFile => {
  const lines = text === "" ? [] : text.split("\n")
  // A final newline ends the last line rather than starting another.
  if (lines.at(-1) === "") lines.pop()
  return {
    ...emptyFile(path),
    status: "added",
    added: lines.length,
    hunks:
      lines.length === 0
        ? []
        : [
            {
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: lines.length,
              lines: lines.map((each) => ({ kind: "add" as const, text: clipLine(each) })),
            },
          ],
  }
}

// An untracked file as git would show it new: held when it may hold secrets, never read
// then; a symlink by its target; a binary file, or one too large, by name.
const untracked = async (root: string, path: string): Promise<ChangedFile | undefined> => {
  const full = join(root, path)
  const base = { ...emptyFile(path), status: "added" as const }
  if (secret(full)) return { ...base, held: true }
  const stats = await lstat(full).catch(() => undefined)
  if (!stats) return undefined
  if (stats.isSymbolicLink()) {
    const target = await readlink(full).catch(() => undefined)
    return target === undefined ? undefined : addedFile(path, target)
  }
  if (!stats.isFile()) return undefined
  if (stats.size > maxUntrackedBytes) return { ...base, listed: true }
  try {
    const handle = await open(
      full,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    )
    try {
      const bytes = Buffer.alloc(Math.min(stats.size, maxUntrackedBytes))
      let read = 0
      while (read < bytes.length) {
        // eslint-disable-next-line no-await-in-loop -- One chunk after another.
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      const got = bytes.subarray(0, read)
      if (got.subarray(0, sniffBytes).includes(0)) return { ...base, binary: true }
      return addedFile(path, got.toString("utf8"))
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    return undefined
  }
}

/**
 * Files within the protocol's bounds: held and binary ones without hunks, and past
 * `maxChangesBytes` of line text, or `maxChangedFiles` files, the rest listed by name and
 * counts, or not at all; `truncated` says either happened.
 */
export const bounded = (
  files: readonly ChangedFile[],
  root: string,
): { files: ChangedFile[]; truncated: boolean } => {
  const kept: ChangedFile[] = []
  let bytes = 0
  let truncated = files.length > maxChangedFiles
  for (const each of files.slice(0, maxChangedFiles)) {
    const held = each.held || secret(join(root, each.path))
    if (held || each.binary) {
      kept.push({ ...each, held, hunks: [] })
      continue
    }
    const size = each.hunks.reduce(
      (sum, hunk) => sum + hunk.lines.reduce((lines, line) => lines + line.text.length, 0),
      0,
    )
    if (bytes + size > maxChangesBytes) {
      kept.push({ ...each, listed: true, hunks: [] })
      truncated = true
      continue
    }
    bytes += size
    kept.push(each)
  }
  return { files: kept, truncated }
}

const failure = (kind: ChangeFailure["kind"], reason: string): ChangeFailure => ({
  ok: false,
  kind,
  reason,
})

/**
 * The repository's folder a directory belongs to, or why not: git isn't installed, the
 * directory is gone, or it isn't in a work tree.
 */
export const repositoryOf = async (
  directory: string,
): Promise<{ readonly ok: true; readonly root: string } | ChangeFailure> => {
  if (!(await stat(directory).catch(() => undefined)))
    return failure("missing", "The terminal's folder no longer exists.")
  const top = await git(directory, ["rev-parse", "--show-toplevel"])
  if (top.ok) return { ok: true, root: resolve(top.out.trim()) }
  if (top.code === "ENOENT")
    return failure("no-git", "Git isn't installed, so changes can't be shown.")
  if (top.code === "timeout") return failure("failed", "Git took too long to answer.")
  return failure(
    "not-a-repository",
    "This terminal's folder isn't in a git repository, so there are no changes to show.",
  )
}

/**
 * A repository's working tree against `HEAD` (the empty tree before its first commit):
 * staged, unstaged and untracked files, but not ignored ones, within the protocol's bounds.
 * Run as the person running `git diff` there would, but never prompting or taking a lock.
 */
export const readChange = async (
  root: string,
): Promise<{ readonly ok: true; readonly change: Change } | ChangeFailure> => {
  const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
  const base = head.ok ? "HEAD" : emptyTree
  if (!head.ok && !head.code.startsWith("exit:1")) return failure("failed", gitFailed(head.code))
  const diff = await git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--find-renames",
    "-U3",
    base,
    "--",
  ])
  if (!diff.ok) return failure("failed", gitFailed(diff.code))
  const others = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  if (!others.ok) return failure("failed", gitFailed(others.code))
  const tracked = parseDiff(diff.out)
  const names = others.out.split("\0").filter((name) => name !== "")
  const fresh: ChangedFile[] = []
  // Only as many untracked files are read as can be shown.
  const readable = Math.max(0, maxChangedFiles - tracked.length)
  for (const name of names.slice(0, readable)) {
    // eslint-disable-next-line no-await-in-loop -- Each file is read in turn.
    const file = await untracked(root, name)
    if (file) fresh.push(file)
  }
  const all = [...tracked, ...fresh]
  const { files, truncated } = bounded(all, root)
  const total = {
    files: tracked.length + names.length,
    added: all.reduce((sum, file) => sum + file.added, 0),
    removed: all.reduce((sum, file) => sum + file.removed, 0),
  }
  return {
    ok: true,
    change: {
      root,
      base: head.ok ? "HEAD" : "HEAD (no commits yet)",
      files,
      truncated: truncated || names.length > readable,
      total,
    },
  }
}

const gitFailed = (code: string): string =>
  code === "timeout"
    ? "Git took too long to read the changes."
    : code === "big"
      ? "The changes are too large to read."
      : code === "ENOENT"
        ? "Git isn't installed, so changes can't be shown."
        : `Git couldn't read the changes${code.split(":")[2] ? `: ${JSON.stringify(code.split(":")[2])}` : "."}`

/** A change's name and one-line detail, as its item shows them. */
export const describeChange = (change: Change): { name: string; detail: string } => ({
  name: `Changes · ${basename(change.root)}`,
  detail:
    `${change.total.files} ${change.total.files === 1 ? "file" : "files"}` +
    ` · +${change.total.added} −${change.total.removed}`,
})

/**
 * A changes item's content as it is now: the repository's change, stamped by a digest of
 * it; a repository gone is `missing`, any other failure `unreadable`.
 */
export const changesContent = async (root: string | null): Promise<ItemContent> => {
  if (root === null) return { state: "unavailable", reason: "missing", size: null }
  const found = await repositoryOf(root)
  if (!found.ok)
    return {
      state: "unavailable",
      reason: found.kind === "missing" ? "missing" : "unreadable",
      size: null,
    }
  const read = await readChange(found.root)
  if (!read.ok) return { state: "unavailable", reason: "unreadable", size: null }
  const { change } = read
  const content = {
    kind: "changes" as const,
    root: change.root,
    base: change.base,
    files: [...change.files],
    truncated: change.truncated,
  }
  return { state: "ready", stamp: hashOf(JSON.stringify(content)), content }
}
