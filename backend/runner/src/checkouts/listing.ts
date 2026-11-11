import type { ChangedFile } from "@novadeck/protocol"

import { git, type Run } from "./git.js"

// The files two commits or trees differ by, counted one way for the Changes panel and the
// changes item alike: renames found, lines counted ignoring whitespace, and the lines that
// only changed whitespace counted apart (`reindented`), so a work's row says what its pane says.

/** How much a listing of git's may print. */
export const metaBytes = 32 * 1024 * 1024

// What every diff of a change is asked: the prefixes are fixed whatever the person's
// diff.noprefix, diff.mnemonicPrefix or diff.srcPrefix say, as the parser relies on them.
export const diffFlags = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--find-renames",
  "--submodule=short",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const

/** One changed file as git's raw and numstat listings give it. */
export type Entry = {
  readonly path: string
  readonly oldPath: string | null
  readonly status: ChangedFile["status"]
  readonly added: number
  readonly removed: number
  readonly binary: boolean
  /** Its object on the listing's later side, all zeros where it was deleted. */
  readonly blob: string
}

const statusOf = (letter: string): ChangedFile["status"] =>
  letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "R" ? "renamed" : "modified"

/**
 * The files of `git diff --raw --no-abbrev --numstat -z`: git prints every file's raw record
 * (its modes, objects, status and names), then every file's counts (`-` for a binary file), in
 * the same order.
 */
export const parseListing = (out: string): Entry[] => {
  const tokens = out.split("\0")
  const raws: Pick<Entry, "status" | "path" | "oldPath" | "blob">[] = []
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>()
  for (let at = 0; at < tokens.length;) {
    const token = tokens[at]!
    if (token.startsWith(":")) {
      const fields = token.split(" ")
      const letter = fields.at(-1)?.[0] ?? "M"
      const blob = fields[3] ?? ""
      if (letter === "R" || letter === "C") {
        raws.push({
          status: statusOf(letter),
          oldPath: tokens[at + 1] ?? "",
          path: tokens[at + 2] ?? "",
          blob,
        })
        at += 3
      } else {
        raws.push({ status: statusOf(letter), oldPath: null, path: tokens[at + 1] ?? "", blob })
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

/** A file as a listing has it: git's entry, and the lines that only changed whitespace. */
export type Listed = Entry & { readonly reindented: number }

/** The files two commits or trees differ by, once read: what two objects differ by never changes. */
const kept = new Map<string, readonly Listed[]>()
const keptMost = 400

const keep = (key: string, files: readonly Listed[]): void => {
  kept.delete(key)
  kept.set(key, files)
  for (const old of kept.keys()) {
    if (kept.size <= keptMost) break
    kept.delete(old)
  }
}

/**
 * The files two commits or trees differ by, renames found, with the lines each added and
 * removed ignoring whitespace; the lines that only changed whitespace are `reindented`. `env`
 * says where a snapshot's objects are. A failed run of git where it can't tell.
 */
export const listChanges = async (
  root: string,
  from: string,
  to: string,
  env?: NodeJS.ProcessEnv,
  /** Whether the listing is kept: not where one end is a snapshot, a new tree every time. */
  store = env === undefined,
): Promise<readonly Listed[] | Extract<Run, { ok: false }>> => {
  const key = `${root}\0${from}\0${to}`
  const known = kept.get(key)
  if (known) return known
  const limit = { cap: metaBytes, ...(env && { env }) }
  const listing = ["--raw", "--no-abbrev", "--numstat", "-z", from, to, "--"]
  const [plain, quiet] = await Promise.all([
    git(root, [...diffFlags, ...listing], limit),
    git(root, [...diffFlags, "-w", ...listing], limit),
  ])
  if (!plain.ok) return plain
  if (!quiet.ok) return quiet
  const ignoring = new Map(parseListing(quiet.out).map((entry) => [entry.path, entry]))
  const files = parseListing(plain.out).map((entry): Listed => {
    const quieter = ignoring.get(entry.path)
    if (!quieter || entry.binary) return { ...entry, reindented: 0 }
    return {
      ...entry,
      added: quieter.added,
      removed: quieter.removed,
      reindented: Math.max(
        0,
        Math.min(entry.added - quieter.added, entry.removed - quieter.removed),
      ),
    }
  })
  if (store) keep(key, files)
  return files
}
