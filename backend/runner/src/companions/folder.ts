import { watch, type FSWatcher } from "node:fs"
import { lstat, readdir, realpath, stat } from "node:fs/promises"
import { extname, isAbsolute, join, relative, sep } from "node:path"

import {
  folderLimits,
  pdfLimits,
  videoLimits,
  type FilePart,
  type FolderEntry,
  type ItemContent,
} from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { tail } from "../text.js"
import { hashOf, isAudio, isImage, isPdf, isVideo, readPart, stampOf } from "./content.js"
import type { ItemRecord } from "./records.js"
import { secrets } from "./secrets.js"

// A folder item lists a folder read-only: what is in it, never what it holds, except through
// `readFolderPart`, which reads a file by the rules its kind has anywhere else. Nothing here
// goes outside the folder the item points at, its top: a link that leaves it is listed as a
// link and neither entered nor read, and a folder that may hold secrets is never listed.

type Unavailable = Extract<ItemContent, { state: "unavailable" }>
const unavailable = (reason: Unavailable["reason"]): Unavailable => ({
  state: "unavailable",
  reason,
  size: null,
})

// What is told as text, by extension: what an editor opens as one.
const texts = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".mdx",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".log",
  ".csv",
  ".tsv",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".py",
  ".rb",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".diff",
  ".patch",
  ".svelte",
  ".vue",
  ".astro",
  ".lock",
])

/** How a file is listed, by its name's extension. */
export const entryKindOf = (name: string): Exclude<FolderEntry["kind"], "folder"> =>
  isImage(name)
    ? "image"
    : isVideo(name)
      ? "video"
      : isAudio(name)
        ? "audio"
        : isPdf(name)
          ? "pdf"
          : texts.has(extname(name).toLowerCase())
            ? "text"
            : "other"

/** Whether `path` is `top` or under it, both real paths. */
const within = (top: string, path: string): boolean => {
  const way = relative(top, path)
  return way === "" || (way !== ".." && !way.startsWith(`..${sep}`) && !isAbsolute(way))
}

/** The names a path from the top is made of, or undefined when it can't stay inside it. */
const segmentsOf = (path: string): readonly string[] | undefined => {
  const segments = path.split("/").filter((segment) => segment !== "")
  return segments.some((segment) => segment === "." || segment === ".." || /[\\\0]/.test(segment))
    ? undefined
    : segments
}

type Walked =
  | { readonly ok: true; readonly top: string; readonly path: string }
  | { readonly ok: false; readonly reason: "missing" | "secret" | "unreadable" }

/**
 * The real path of `way` (from the top of the folder item, "/" between names), step by step:
 * each step resolved through links, which must stay inside the top, and may not hold secrets.
 */
const walk = async (
  folder: string,
  way: string,
  isSecret: (path: string) => boolean,
): Promise<Walked> => {
  let top: string
  try {
    top = await realpath(folder)
  } catch (error) {
    return { ok: false, reason: errnoOf(error) === "EACCES" ? "unreadable" : "missing" }
  }
  if (isSecret(top)) return { ok: false, reason: "secret" }
  const segments = segmentsOf(way)
  if (!segments) return { ok: false, reason: "missing" }
  let path = top
  for (const segment of segments) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Each step begins where the last ended.
      path = await realpath(join(path, segment))
    } catch (error) {
      return { ok: false, reason: errnoOf(error) === "EACCES" ? "unreadable" : "missing" }
    }
    if (!within(top, path)) return { ok: false, reason: "missing" }
    if (isSecret(path)) return { ok: false, reason: "secret" }
  }
  return { ok: true, top, path }
}

const errnoOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

// How many entries are statted at once.
const concurrency = 16

/** Runs `work` over `items`, a few at a time, in their order. */
const mapBounded = async <Item, Result>(
  items: readonly Item[],
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> => {
  const results: Result[] = []
  let next = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      // eslint-disable-next-line no-await-in-loop -- Each runner takes the next one.
      results[index] = await work(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}

/** How many entries a folder holds, or null where it can't be read. */
const countOf = (path: string): Promise<number | null> =>
  readdir(path).then(
    (names) => names.length,
    () => null,
  )

/** One entry of a folder as it is listed; undefined where it vanished meanwhile. */
const entryOf = async (
  top: string,
  folder: string,
  name: string,
  isSecret: (path: string) => boolean,
): Promise<FolderEntry | undefined> => {
  const full = join(folder, name)
  const own = await lstat(full).catch(() => undefined)
  if (!own) return undefined
  let real = full
  let stats = own
  if (own.isSymbolicLink()) {
    // A link that leaves the top, or leads nowhere, is listed as itself.
    const target = await realpath(full).catch(() => undefined)
    const targeted =
      target && within(top, target) ? await stat(target).catch(() => undefined) : undefined
    if (!target || !targeted)
      return {
        name,
        kind: "other",
        size: own.size,
        modifiedAt: own.mtimeMs,
        children: null,
        secret: isSecret(full),
        link: true,
        stamp: "",
      }
    real = target
    stats = targeted
  }
  const held = isSecret(full) || isSecret(real)
  const base = {
    name,
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    secret: held,
    link: false,
  }
  if (stats.isDirectory())
    return {
      ...base,
      kind: "folder",
      size: 0,
      children: held ? null : await countOf(real),
      stamp: "",
    }
  const kind = stats.isFile() ? entryKindOf(name) : "other"
  return { ...base, kind, children: null, stamp: held || !stats.isFile() ? "" : stampOf(stats) }
}

/**
 * The folder `inside` names, from the top the item points at, as it is now: its entries, sorted
 * by name, the first `folderLimits.entries` of them. The folder where it is read is `dir`,
 * which a watcher follows. A top that is gone is `gone`; a folder inside that is gone, or that
 * a link takes out of the top, is `missing`; one that may hold secrets is `secret`, and is
 * never read.
 */
export const loadFolder = async (
  item: Pick<ItemRecord, "path">,
  inside: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ readonly content: ItemContent; readonly dir: string | undefined }> => {
  const isSecret = secrets(env)
  if (item.path === null) return { content: unavailable("gone"), dir: undefined }
  const walked = await walk(item.path, inside, isSecret)
  if (!walked.ok) {
    const top = inside === "" || inside === "/"
    return {
      content: unavailable(walked.reason === "missing" && top ? "gone" : walked.reason),
      dir: undefined,
    }
  }
  const { top, path: dir } = walked
  let names: string[]
  try {
    const own = await stat(dir)
    if (!own.isDirectory()) return { content: unavailable(inside === "" ? "gone" : "missing"), dir }
    names = (await readdir(dir)).toSorted()
  } catch (error) {
    const reason = errnoOf(error) === "EACCES" ? "unreadable" : inside === "" ? "gone" : "missing"
    return { content: unavailable(reason), dir }
  }
  const listed = names.slice(0, folderLimits.entries)
  const found = await mapBounded(listed, (name) => entryOf(top, dir, name, isSecret))
  const entries = found.filter((entry): entry is FolderEntry => entry !== undefined)
  const truncated = names.length > folderLimits.entries
  const path = tail(dir, 4096)
  return {
    dir,
    content: {
      state: "ready",
      stamp: hashOf(JSON.stringify([inside, truncated, entries])),
      content: {
        kind: "folder",
        path,
        within: segmentsOf(inside)?.join("/") ?? "",
        entries,
        total: names.length,
        truncated,
      },
    },
  }
}

/** The largest file a listed file of a kind is read to, for what it is read for. */
const partLimits: { readonly [kind in FolderEntry["kind"]]?: number } = {
  image: folderLimits.thumbnail,
  video: videoLimits.bytes,
  audio: videoLimits.bytes,
  pdf: pdfLimits.bytes,
}

/**
 * A part of a file of the folder item (see `companions.part`), by its path from the top: read
 * as its kind is anywhere, against the stamp its listing gave. NOT_FOUND for a kind not read
 * in parts. A path that leaves the top, through a link too, is `missing`; a secret file, or one
 * in a secret folder, `secret`.
 */
export const readFolderPart = async (
  item: Pick<ItemRecord, "path">,
  part: { readonly path: string; readonly stamp: string; readonly offset: number },
  env?: NodeJS.ProcessEnv,
): Promise<FilePart> => {
  const name = segmentsOf(part.path)?.at(-1)
  if (item.path === null || name === undefined) return { state: "unavailable", reason: "missing" }
  const largest = partLimits[entryKindOf(name)]
  if (largest === undefined) throw new DomainError("NOT_FOUND", "That file isn't read in parts")
  const walked = await walk(item.path, part.path, secrets(env))
  if (!walked.ok) return { state: "unavailable", reason: walked.reason }
  return readPart({ path: walked.path, secret: false }, part, false, largest, env)
}

/** How soon after a change the folder is read again, so a burst of writes is read once. */
const settle = 200
/** The longest a steady stream of changes holds a read back. */
const longest = 1000

/**
 * Tells when a folder may have changed: the file system's own watch, a few events together as
 * one, and never later than `longest` after the first of them. Where it can't watch (a
 * network share, a limit of watches reached) it tells nothing, and the caller's own wait
 * ends the pause.
 */
export class FolderWatch {
  private watcher: FSWatcher | undefined
  private dir: string | undefined
  private first: number | undefined
  private wake: (() => void) | undefined

  /** Watches `dir`, in place of the folder watched before. */
  follow(dir: string | undefined): void {
    if (dir === this.dir) return
    this.watcher?.close()
    this.watcher = undefined
    this.dir = dir
    this.first = undefined
    if (dir === undefined) return
    try {
      this.watcher = watch(dir, { persistent: false }, () => {
        this.first ??= Date.now()
        this.wake?.()
      })
      this.watcher.on("error", () => {
        this.watcher?.close()
        this.watcher = undefined
      })
    } catch {
      this.watcher = undefined
    }
  }

  /** Resolves when the folder changed and settled, or after `ms`, or when `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener("abort", done)
        this.wake = undefined
        this.first = undefined
        resolve()
      }
      const arm = (): void => {
        clearTimeout(timer)
        if (this.first === undefined) {
          timer = setTimeout(done, ms)
          return
        }
        const left = Math.max(0, this.first + longest - Date.now())
        timer = setTimeout(done, Math.min(settle, left))
      }
      this.wake = arm
      signal.addEventListener("abort", done, { once: true })
      if (signal.aborted) return done()
      arm()
    })
  }

  close(): void {
    this.watcher?.close()
    this.watcher = undefined
    this.dir = undefined
  }
}
