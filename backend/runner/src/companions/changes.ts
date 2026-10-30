import { spawn } from "node:child_process"
import { constants, statSync } from "node:fs"
import { lstat, open, readlink, stat } from "node:fs/promises"
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path"

import {
  hiddenCharacter,
  maxChangedFiles,
  maxChangesBytes,
  type ChangedFile,
  type ItemContent,
} from "@novadeck/protocol"

import { cut } from "../text.js"
import { hashOf, maxLineChars } from "./content.js"
import { secret } from "./secrets.js"

/** The empty tree, which a repository with no commit yet is diffed against, by object format. */
const emptyTrees = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const
/** How long one git run may take (a test shortens it), and how much of its output is kept. */
export const timing = {
  gitMs: 5_000,
  /** A read slower than this makes the next wait longer (a test shortens it). */
  slowMs: 1_000,
  /** Called with the arguments of each git run (a test looks at them). */
  saw: undefined as ((args: readonly string[]) => void) | undefined,
}
const metaBytes = 32 * 1024 * 1024
// Only the first names of the untracked files are shown, so only so many are read.
const namesBytes = 2 * 1024 * 1024
// The raw diff text read: what fits the budget needs hardly more than the budget itself.
const patchBytes = 2 * maxChangesBytes
// A text file has no NUL byte in this much of its start.
const sniffBytes = 8 * 1024
// Untracked files: the largest one read, and how much all of them are read in one look.
const maxUntrackedBytes = 1024 * 1024
const untrackedReadBytes = 8 * 1024 * 1024
// What a line of a change costs beyond its text, once encoded: its kind and punctuation.
const lineOverhead = 30

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
type ChangeFailure = {
  readonly ok: false
  readonly kind: "not-a-repository" | "no-git" | "missing" | "failed"
  readonly reason: string
}

type Run =
  | { readonly ok: true; readonly out: string; readonly cut: boolean }
  | {
      readonly ok: false
      readonly kind: "no-git" | "timeout" | "big" | "exit"
      readonly status: number
      readonly said: string
    }

// What a page, a file or git supplies, shown as one line without invisible characters.
const hidden = new RegExp(hiddenCharacter.source, "gu")
const oneLine = (text: string, max: number): string => {
  const line = text.replaceAll(hidden, " ").replaceAll(/\s+/g, " ").trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}
/** A name for display: each invisible or control character shows as U+FFFD, the rest as it is. */
export const displayed = (text: string): string =>
  text.replaceAll(hidden, "\uFFFD").replaceAll(/[\t\n]/g, "\uFFFD")

// Git, found once on the PATH by an absolute entry, so a program of that name in the
// repository the child runs in (as Windows searches its working folder first) never runs.
let gitProgram: string | undefined
const gitPath = (): string | undefined => {
  if (gitProgram) return gitProgram
  const names = process.platform === "win32" ? ["git.exe"] : ["git"]
  for (const folder of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (folder === "" || !isAbsolute(folder)) continue
    for (const name of names) {
      const candidate = join(folder, name)
      try {
        if (statSync(candidate).isFile()) return (gitProgram = candidate)
      } catch {
        // Not here.
      }
    }
  }
  return undefined
}

// The variables of the person's environment that point git at another repository, another
// configuration or another way to diff, or make it write traces: the runner may have them
// from wherever it was started, and what it shows is this terminal's repository as the
// person's git would show it. The rest (GIT_CEILING_DIRECTORIES, GIT_EXEC_PATH…) stay.
const redirecting =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|INDEX_VERSION|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CONFIG.*|EXTERNAL_DIFF|DIFF_OPTS|PAGER|EDITOR|SEQUENCE_EDITOR|.*_PATHSPECS|REPLACE_REF_BASE|NO_REPLACE_OBJECTS|SHALLOW_FILE|GRAFT_FILE|ATTR_SOURCE|TRACE.*)$/

// The environment git runs in: the person's own, but for those, with optional locks off so
// looking never takes the index lock the agent's own git needs, no prompts, and no
// fetching of missing objects over the network.
export const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !redirecting.test(name.toUpperCase())),
  ),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  // Pathspecs are file names, not patterns.
  GIT_LITERAL_PATHSPECS: "1",
  // Git's messages are read for "not a git repository", so they are English whatever the
  // system's locale; names travel as bytes (-z, quotepath off), which the locale never touches.
  LC_ALL: "C",
  LANGUAGE: "C",
})

// Ends git and what it started (a filter's program, a credential helper): its whole group
// on POSIX, its tree on Windows.
const killTree = (pid: number | undefined): void => {
  if (pid === undefined) return
  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`
    spawn(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => {})
      .unref()
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
}

// Runs git as the person would, with no shell, a fixed argument list and the environment
// above. Switched off: a repository's file monitor hook program (git's own monitor stays,
// as `limit.monitor` says), external diff programs, text conversion, a pager and prompts. Not switched off: clean filters (git-lfs, say) of
// files whose stat changed, which run as in the person's own `git diff`. Output past
// `cap` bytes ends the run: it is `cut` where `truncate`, else a failure.
const git = (
  cwd: string,
  args: readonly string[],
  limit: { readonly cap: number; readonly truncate?: boolean; readonly monitor?: boolean },
): Promise<Run> =>
  new Promise((done) => {
    const program = gitPath()
    if (!program) return done({ ok: false, kind: "no-git", status: 0, said: "" })
    let settled = false
    const finish = (run: Run) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(run)
    }
    const full = [
      "-c",
      "core.quotepath=off",
      // A hook program named by the repository's config never runs; git's own monitor
      // (`core.fsmonitor=true`), which big repositories rely on, stays.
      ...(limit.monitor ? [] : ["-c", "core.fsmonitor=false"]),
      ...args,
    ]
    timing.saw?.(full)
    const child = spawn(program, full, {
      cwd,
      env: gitEnv(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const chunks: Buffer[] = []
    let size = 0
    let capped = false
    let errors = Buffer.alloc(0)
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish({ ok: false, kind: "timeout", status: 0, said: "" })
    }, timing.gitMs)
    child.stdout?.on("data", (chunk: Buffer) => {
      if (capped) return
      if (size + chunk.length > limit.cap) {
        capped = true
        chunks.push(chunk.subarray(0, limit.cap - size))
        killTree(child.pid)
        return
      }
      size += chunk.length
      chunks.push(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errors.length < 4096) errors = Buffer.concat([errors, chunk])
    })
    child.on("error", (error: NodeJS.ErrnoException) => {
      // A folder gone since is not git gone.
      const folder = error.code !== "ENOENT" || statSync(cwd, { throwIfNoEntry: false })
      finish({
        ok: false,
        kind: folder ? (error.code === "ENOENT" ? "no-git" : "exit") : "exit",
        status: -1,
        said: folder ? oneLine(error.message, 200) : "the folder is gone",
      })
    })
    child.on("close", (code) => {
      const out = Buffer.concat(chunks).toString("utf8")
      if (capped)
        return finish(
          limit.truncate
            ? { ok: true, out, cut: true }
            : { ok: false, kind: "big", status: 0, said: "" },
        )
      if (code === 0) return finish({ ok: true, out, cut: false })
      const said = oneLine(errors.toString("utf8").split("\n")[0] ?? "", 200)
      finish({ ok: false, kind: "exit", status: code ?? -1, said })
    })
  })

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
const clipLine = (text: string): string => cut(text, maxLineChars)

/** What is left of the diff text a change may carry, as encoded: shared by its files. */
export type Budget = { left: number }

const costOf = (text: string): number => Buffer.byteLength(JSON.stringify(text)) + lineOverhead

const emptyFile = (path: string): ChangedFile => ({
  path,
  oldPath: null,
  status: "modified",
  added: 0,
  removed: 0,
  binary: false,
  secret: false,
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
  options: { readonly budget?: Budget; readonly skip?: (file: ChangedFile) => boolean } = {},
): ChangedFile[] => {
  const { budget, skip } = options
  const files: ChangedFile[] = []
  let file: ChangedFile | undefined
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

/** One changed file as git's raw and numstat listings give it. */
type Entry = {
  readonly path: string
  readonly oldPath: string | null
  readonly status: ChangedFile["status"]
  readonly added: number
  readonly removed: number
  readonly binary: boolean
}

const statusOf = (letter: string): ChangedFile["status"] =>
  letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "R" ? "renamed" : "modified"

/**
 * The files of `git diff --raw --numstat -z`: git prints every file's raw record (its
 * status and names), then every file's counts (`-` for a binary file), in the same order.
 */
export const parseListing = (out: string): Entry[] => {
  const tokens = out.split("\0")
  const raws: { status: ChangedFile["status"]; path: string; oldPath: string | null }[] = []
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>()
  for (let at = 0; at < tokens.length;) {
    const token = tokens[at]!
    if (token.startsWith(":")) {
      const letter = token.split(" ").at(-1)?.[0] ?? "M"
      if (letter === "R" || letter === "C") {
        raws.push({
          status: statusOf(letter),
          oldPath: tokens[at + 1] ?? "",
          path: tokens[at + 2] ?? "",
        })
        at += 3
      } else {
        raws.push({ status: statusOf(letter), oldPath: null, path: tokens[at + 1] ?? "" })
        at += 2
      }
      continue
    }
    const numbers = /^(\d+|-)\t(\d+|-)\t([^]*)$/.exec(token)
    if (!numbers) {
      at += 1
      continue
    }
    const renamed = numbers[3] === ""
    counts.set(renamed ? (tokens[at + 2] ?? "") : numbers[3]!, {
      added: numbers[1] === "-" ? 0 : Number(numbers[1]),
      removed: numbers[2] === "-" ? 0 : Number(numbers[2]),
      binary: numbers[1] === "-",
    })
    at += renamed ? 3 : 1
  }
  return raws.map((raw) => ({
    ...raw,
    ...(counts.get(raw.path) ?? { added: 0, removed: 0, binary: false }),
  }))
}

/** A new file's text as all-added lines, as git would diff it against nothing. */
const addedFile = (path: string, text: string, budget: Budget): ChangedFile => {
  const lines = text === "" ? [] : text.split("\n")
  // A final newline ends the last line rather than starting another.
  if (lines.at(-1) === "") lines.pop()
  const base: ChangedFile = { ...emptyFile(path), status: "added", added: lines.length }
  const shown = lines.map(clipLine)
  let cost = 0
  for (const line of shown) {
    cost += costOf(line)
    if (cost > budget.left) return { ...base, listed: true }
  }
  budget.left -= cost
  if (shown.length === 0) return base
  return {
    ...base,
    hunks: [
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: shown.length,
        lines: shown.map((line) => ({ kind: "add" as const, text: line })),
      },
    ],
  }
}

// An untracked file as git would show it new: secret when it may hold secrets, never read
// then; a symlink by its target; a binary file, or one too large to read, by name.
const untracked = async (
  root: string,
  path: string,
  budget: Budget,
  reading: { left: number },
): Promise<ChangedFile | undefined> => {
  const full = join(root, path)
  const base = { ...emptyFile(path), status: "added" as const }
  if (secret(full)) return { ...base, secret: true }
  // Once the diff text or the reading is spent, the rest are listed without a look.
  if (budget.left <= 0 || reading.left <= 0) return { ...base, listed: true }
  const stats = await lstat(full).catch(() => undefined)
  if (!stats) return undefined
  if (stats.isSymbolicLink()) {
    const target = await readlink(full).catch(() => undefined)
    return target === undefined ? undefined : addedFile(path, target, budget)
  }
  if (!stats.isFile()) return undefined
  if (stats.size > maxUntrackedBytes || stats.size > reading.left) return { ...base, listed: true }
  try {
    const handle = await open(
      full,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    )
    try {
      const bytes = Buffer.alloc(stats.size)
      let read = 0
      while (read < bytes.length) {
        // eslint-disable-next-line no-await-in-loop -- One chunk after another.
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      reading.left -= read
      const got = bytes.subarray(0, read)
      if (got.subarray(0, sniffBytes).includes(0)) return { ...base, binary: true }
      return addedFile(path, got.toString("utf8"), budget)
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    return undefined
  }
}

const failure = (kind: ChangeFailure["kind"], reason: string): ChangeFailure => ({
  ok: false,
  kind,
  reason,
})

/** Why a git run failed, in a sentence: git's own first line where it said one. */
const reasonOf = (run: Extract<Run, { ok: false }>, doing: string): string => {
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

// What every diff of a change is asked: the prefixes are fixed whatever the person's
// diff.noprefix, diff.mnemonicPrefix or diff.srcPrefix say, as the parser relies on them.
const diffFlags = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--find-renames",
  "--submodule=short",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const

// The least a changed line costs, as encoded: two quotes of its text and its overhead.
const minLineCost = lineOverhead + 2
// How long the file names on one git command line may be in all: Windows allows 32767.
const maxCommandChars = 16_000
// How many times a cut patch is asked for again without the file that cut it.
const maxPatchRuns = 4

// The diff of the wanted files alone, by their literal names (the old name of a rename
// too, or it would show as a new file), in as few runs as keep each command line short
// enough for any system; their outputs follow one another, within `patchBytes` in all.
// Whether a name reached us as U+FFFD, being no valid UTF-8.
const unnamed = (entry: Entry): boolean =>
  entry.path.includes("\uFFFD") || (entry.oldPath?.includes("\uFFFD") ?? false)

const patchOf = async (
  root: string,
  base: string,
  wanted: readonly Entry[],
  monitor: boolean,
): Promise<Run> => {
  // A name that isn't valid UTF-8 reached us as U+FFFD, which no command line can give
  // back to git (and `git diff` takes no pathspec file): the whole diff is read instead,
  // within the same cap, and its sections pair with the listing by the same decoding.
  if (wanted.some(unnamed))
    return git(root, [...diffFlags, "-U3", base, "--"], {
      cap: patchBytes,
      truncate: true,
      monitor,
    })
  const groups: string[][] = []
  let length = 0
  for (const entry of wanted) {
    const names = entry.oldPath === null ? [entry.path] : [entry.oldPath, entry.path]
    const size = names.reduce((sum, name) => sum + name.length + 1, 0)
    if (groups.length === 0 || length + size > maxCommandChars) {
      groups.push([])
      length = 0
    }
    groups.at(-1)!.push(...names)
    length += size
  }
  let out = ""
  for (const names of groups) {
    // eslint-disable-next-line no-await-in-loop -- Each run takes what the one before left.
    const run = await git(root, [...diffFlags, "-U3", base, "--", ...names], {
      cap: patchBytes - Buffer.byteLength(out),
      truncate: true,
      monitor,
    })
    if (!run.ok) return run
    out += run.out
    if (run.cut) return { ok: true, out, cut: true }
  }
  return { ok: true, out, cut: false }
}

/**
 * A repository's working tree against `HEAD` (the empty tree before its first commit):
 * staged, unstaged and untracked files, but not ignored ones. Files are listed with their
 * counts by git alone, then diffed as far as the encoded diff text fits `maxChangesBytes`,
 * and at most `maxChangedFiles` are carried. Run as `git diff` by the person would, but
 * never prompting or taking a lock.
 */
export const readChange = async (
  root: string,
): Promise<{ readonly ok: true; readonly change: Change } | ChangeFailure> => {
  const configured = await git(
    root,
    ["config", "--get-regexp", "^(core\\.fsmonitor|status\\.showuntrackedfiles)$"],
    // Reading the configuration never consults a file monitor; and it must not be told it is
    // off, as git lists what is set on its command line last.
    { cap: 16 * 1024, monitor: true },
  )
  // Of the person's configuration: git's own file monitor stays (`core.fsmonitor=true`; a
  // hook program named there never runs), and untracked files are not shown where status
  // doesn't show them.
  const set = new Map<string, string>()
  if (configured.ok)
    for (const line of configured.out.split("\n")) {
      const space = line.indexOf(" ")
      if (space > 0) set.set(line.slice(0, space), line.slice(space + 1).trim())
    }
  const monitor = /^(true|yes|on|1)$/i.test(set.get("core.fsmonitor") ?? "")
  const showUntracked = !/^(no|false|off|0)$/i.test(set.get("status.showuntrackedfiles") ?? "")
  const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { cap: 4096, monitor })
  if (!head.ok && !(head.kind === "exit" && head.status === 1))
    return failure("failed", reasonOf(head, "read the changes"))
  let base = "HEAD"
  if (!head.ok) {
    const format = await git(root, ["rev-parse", "--show-object-format"], { cap: 4096, monitor })
    base = format.ok && format.out.trim() === "sha256" ? emptyTrees.sha256 : emptyTrees.sha1
  }
  const [listing, others] = await Promise.all([
    git(root, [...diffFlags, "--raw", "--numstat", "-z", base, "--"], { cap: metaBytes, monitor }),
    showUntracked
      ? git(root, ["ls-files", "--others", "--exclude-standard", "-z"], {
          cap: namesBytes,
          truncate: true,
          monitor,
        })
      : { ok: true as const, out: "", cut: false },
  ])
  if (!listing.ok) return failure("failed", reasonOf(listing, "read the changes"))
  if (!others.ok) return failure("failed", reasonOf(others, "read the changes"))

  const entries = parseListing(listing.out)
  const secretAt = (path: string, oldPath: string | null) =>
    secret(join(root, path)) || (oldPath !== null && secret(join(root, oldPath)))
  // Only files that can fit are diffed, so one that can't (a regenerated lockfile) takes
  // none of the patch's room from those after it: each changed line costs at least
  // `minLineCost`, and a file is wanted while the files wanted so far and it still could.
  const wanted: Entry[] = []
  let planned = 0
  for (const entry of entries.slice(0, maxChangedFiles)) {
    const least = (entry.added + entry.removed) * minLineCost
    if (secretAt(entry.path, entry.oldPath) || entry.binary || least === 0) continue
    if (planned + least > maxChangesBytes) continue
    planned += least
    wanted.push(entry)
  }
  const budget: Budget = { left: maxChangesBytes }
  // A type change (a file made a symlink, or the reverse) prints a section for each side
  // of one path: both are its hunks, the old side first.
  const parsed = new Map<string, ChangedFile>()
  // A file that may hold secrets is not even looked at in the diff: neither its new name
  // nor the one a rename took it from.
  const skip = (file: ChangedFile) => secretAt(file.path, file.oldPath)
  // A patch that was cut ends in a file too big to read (one very long line, say): that
  // file is listed, and the files after it are asked for again, so it takes none of their
  // room. The retries are few; what is still unread then is listed too.
  let remaining = wanted
  for (
    let attempt = 0;
    attempt < maxPatchRuns && remaining.length > 0 && budget.left >= minLineCost;
    attempt += 1
  ) {
    // eslint-disable-next-line no-await-in-loop -- Each run follows the cut of the one before.
    const patch = await patchOf(root, base, remaining, monitor)
    if (!patch.ok) return failure("failed", reasonOf(patch, "read the changes"))
    const diffed = parseDiff(patch.out, { budget, skip })
    // Output that was cut ends in a file only partly read.
    const culprit = patch.cut ? (diffed.pop()?.path ?? remaining[0]?.path) : undefined
    for (const file of diffed) {
      const earlier = parsed.get(file.path)
      parsed.set(
        file.path,
        earlier
          ? {
              ...file,
              listed: earlier.listed || file.listed,
              hunks: [...earlier.hunks, ...file.hunks],
            }
          : file,
      )
    }
    // A name that isn't valid UTF-8 reads the whole diff, which can't leave a file out.
    const whole = remaining.some(unnamed)
    if (!patch.cut || whole) break
    const done = new Set([...diffed.map((file) => file.path), culprit])
    remaining = remaining.filter((entry) => !done.has(entry.path))
  }
  let truncated = entries.length > maxChangedFiles
  const files: ChangedFile[] = []
  for (const entry of entries.slice(0, maxChangedFiles)) {
    const isSecret = secretAt(entry.path, entry.oldPath)
    const lines = entry.added + entry.removed > 0
    const own = parsed.get(entry.path)
    const hunks = !isSecret && !entry.binary && lines && own && !own.listed ? own.hunks : undefined
    const listed = !isSecret && !entry.binary && lines && hunks === undefined
    if (listed) truncated = true
    files.push({
      ...emptyFile(entry.path),
      oldPath: entry.oldPath,
      status: entry.status,
      added: entry.added,
      removed: entry.removed,
      binary: entry.binary,
      secret: isSecret,
      listed,
      hunks: hunks ?? [],
    })
  }

  // A path git lists both as changed and as untracked (removed from the index only) counts
  // once; a list that was cut ends in a name only partly read.
  const known = new Set(entries.map((entry) => entry.path))
  const listed = others.out.split("\0")
  if (others.cut) listed.pop()
  const names = listed.filter((name) => name !== "" && !known.has(name))
  const slots = Math.max(0, maxChangedFiles - entries.length)
  if (names.length > slots || others.cut) truncated = true
  const reading = { left: untrackedReadBytes }
  let kept = 0
  for (const name of names.slice(0, slots)) {
    // eslint-disable-next-line no-await-in-loop -- Each file is read in turn, within the budget.
    const file = await untracked(root, name, budget, reading)
    if (!file) continue
    kept += 1
    if (file.listed) truncated = true
    files.push(file)
  }

  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  return {
    ok: true,
    change: {
      root,
      base: head.ok ? "HEAD" : "HEAD (no commits yet)",
      files: files.map((file) => ({
        ...file,
        path: displayed(file.path),
        oldPath: file.oldPath === null ? null : displayed(file.oldPath),
      })),
      truncated,
      total: { files: entries.length + kept + Math.max(0, names.length - slots), added, removed },
    },
  }
}

/** A change's name and one-line detail, as its item shows them; the folder's name is cleaned. */
export const describeChange = (change: Change): { name: string; detail: string } => ({
  name: `Changes · ${oneLine(basename(change.root), 200)}`,
  detail:
    `${change.total.files} ${change.total.files === 1 ? "file" : "files"}` +
    ` · +${change.total.added} −${change.total.removed}`,
})

/** Whether two paths name one folder; Windows folds case. */
export const samePlace = (a: string, b: string): boolean =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b)

const unavailable = (reason: "missing" | "unreadable") => ({
  content: { state: "unavailable" as const, reason, size: null },
})

/**
 * A changes item's content as it is now, stamped by a digest of it, with the detail its
 * item should carry; a repository gone is `missing`, any other failure `unreadable`.
 */
export const changesContent = async (
  root: string | null,
): Promise<{ readonly content: ItemContent; readonly detail?: string }> => {
  if (root === null) return unavailable("missing")
  const found = await repositoryOf(root)
  if (!found.ok) return unavailable(found.kind === "missing" ? "missing" : "unreadable")
  // A repository that lost its own .git is now a folder of another: that is not its change.
  if (!samePlace(found.root, root)) return unavailable("missing")
  const read = await readChange(found.root)
  if (!read.ok) return unavailable("unreadable")
  const { change } = read
  const content = {
    kind: "changes" as const,
    root: change.root,
    base: change.base,
    files: [...change.files],
    truncated: change.truncated,
  }
  return {
    content: { state: "ready", stamp: hashOf(JSON.stringify(content)), content },
    detail: describeChange(change).detail,
  }
}

// A change read slower than this is polled less often; it is polled at most this seldom.
const maxChangesWait = 15_000

/**
 * How long to wait before reading a change again, given how long the last read `took`
 * and the usual `every`: after a slow read (a big repository) four times as long as it
 * took, up to 15 seconds, and the usual wait again as reads get fast.
 */
export const waitAfter = (took: number, every: number): number =>
  took > timing.slowMs ? Math.min(maxChangesWait, Math.max(every, took * 4)) : every
