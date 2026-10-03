import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { open, realpath, stat, type FileHandle } from "node:fs/promises"
import { basename, extname, resolve } from "node:path"
import { StringDecoder } from "node:string_decoder"

import type { AgentName, ItemContent } from "@novadeck/protocol"

import type { PlanSource } from "../harnesses/events.js"
import { harnesses } from "../harnesses/registry.js"
import type { ItemRecord } from "./records.js"
import { failure, maxUrlChars, type PresentFailure } from "./request.js"
import { secret } from "./secrets.js"

// What is shown as an image, by extension.
const images: { readonly [extension: string]: string } = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
}
/** The largest image previewed; a larger one is listed without its picture. */
export const maxImageBytes = 8 * 1024 * 1024
// How much of a text file is read past the lines it shows, to count its lines; past it,
// its line count is unknown.
const textBudget = 4 * 1024 * 1024
// How much of a file is read at a time.
const chunkBytes = 64 * 1024
// A text file has no NUL byte in this much of its start.
const sniffBytes = 8 * 1024
// A file this long is shown whole; a longer one, around what was pointed at.
const wholeLines = 400
const contextLines = 40
// What the protocol takes of a file and a plan.
const maxLines = 2000
const maxLineChars = 4096
const maxPlanBytes = 256 * 1024

/** What an item's content reads of a pointer: unavailable, with why, or ready. */
type Unavailable = Extract<ItemContent, { state: "unavailable" }>
const unavailable = (reason: Unavailable["reason"], size: number | null = null): Unavailable => ({
  state: "unavailable",
  reason,
  size,
})

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(text.length - max + 1)}`

/** Whether a file is shown as an image, by its extension. */
export const isImage = (path: string): boolean => images[extname(path).toLowerCase()] !== undefined

/**
 * The lines of a file of `total` lines shown, from `first` to `last`, and the ones
 * pointed at, `from` to `to`: every line of a short file; around `lines` in a longer
 * one, with some context each side; or its start. Lines past the end are pulled back to
 * it, and `clamped` says so.
 */
export const captureWindow = (
  total: number,
  lines: { readonly from: number; readonly to: number } | null | undefined,
): { first: number; last: number; from: number; to: number; clamped: boolean } => {
  const from = Math.min(lines?.from ?? 1, total)
  const to = Math.min(lines?.to ?? total, total)
  const clamped = lines !== null && lines !== undefined && (from !== lines.from || to !== lines.to)
  if (total <= wholeLines) return { first: 1, last: total, from, to, clamped }
  if (!lines) return { first: 1, last: wholeLines, from: 1, to: wholeLines, clamped }
  const first = Math.max(1, from - contextLines)
  const last = Math.min(total, to + contextLines, first + maxLines - 1)
  return { first, last, from, to: Math.min(to, last), clamped }
}

/** What a path points at, once checked the cheap way, as show and attach take it. */
export type Pointed = {
  readonly ok: true
  /** Its path, symlinks resolved. */
  readonly path: string
  readonly kind: "image" | "file"
  readonly size: number
  readonly held: boolean
}

/**
 * A file a request points at, from the terminal's directory: anything but a missing
 * path, a folder, or a pipe or device. What it holds is read only as it loads.
 */
export const pointAt = async (given: string, cwd: string): Promise<Pointed | PresentFailure> => {
  const path = await realpath(resolve(cwd, given)).catch(() => undefined)
  if (!path) return failure("That file doesn't exist.")
  const stats = await stat(path).catch(() => undefined)
  if (!stats) return failure("That file doesn't exist.")
  if (stats.isDirectory()) return failure("That's a folder; only files can be shown.")
  if (!stats.isFile()) return failure("Only files can be shown, not a pipe or a device.")
  return {
    ok: true,
    path,
    kind: isImage(path) ? "image" : "file",
    size: stats.size,
    held: secret(path),
  }
}

/**
 * A page, by its address: any http(s) page, which the desktop app loads in its own
 * locked-down browser view. An address carrying a user name or password is refused,
 * as it would show them.
 */
export const pageAt = (
  address: string,
): { readonly ok: true; readonly url: URL } | PresentFailure => {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return failure("That isn't a valid address.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return failure("NovaDeck shows only http and https pages.")
  if (url.username || url.password)
    return failure("NovaDeck won't show an address with a user name or password in it.")
  // Encoding can lengthen it past what the protocol carries.
  if (url.href.length > maxUrlChars) return failure("That address is too long.")
  return { ok: true, url }
}

/** Why a file can't be read, by its error. */
const reasonOf = (error: unknown): Unavailable["reason"] => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === "ENOENT" || code === "ENOTDIR") return "missing"
  if (code === "EISDIR") return "not-a-file"
  return "unreadable"
}

/** What says a file changed: its size, when it last changed, and which file it is. */
const stampOf = (stats: Stats): string => `${stats.size}:${stats.mtimeMs}:${stats.ino}`

/** A short digest of a text, as a stamp. */
export const hashOf = (text: string): string =>
  createHash("sha256").update(text).digest("base64url").slice(0, 22)

/**
 * Opens a plain file for reading: a pipe or device put in its place never blocks the
 * reader, and a symlink put there since it was resolved isn't followed.
 */
const openPlain = async (
  path: string,
): Promise<{ handle: FileHandle; stats: Stats } | Unavailable> => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  const stats = await handle.stat().catch(async (error: unknown) => {
    await handle.close()
    throw error
  })
  if (stats.isFile()) return { handle, stats }
  await handle.close()
  return unavailable("not-a-file")
}

/**
 * Reads up to `limit` bytes of a file, to its end rather than its reported size, which a
 * file in /proc gives as 0; `more` when it holds more than that.
 */
const readUpTo = async (
  handle: FileHandle,
  limit: number,
): Promise<{ bytes: Buffer; more: boolean }> => {
  const buffer = Buffer.alloc(limit + 1)
  let read = 0
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- One chunk after another.
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
    read += bytesRead
    if (bytesRead === 0 || read === buffer.length) break
  }
  return { bytes: buffer.subarray(0, Math.min(read, limit)), more: read > limit }
}

/**
 * Streams a text file's lines, keeping those it may show: its first `wholeLines`, and
 * those around `range` with their context. It reads on to the last of those, then up to
 * `textBudget` more to count the rest; `ended` once it reached the file's end. Each kept
 * line is cut to what the protocol takes. A NUL byte near its start makes it binary.
 */
const readLines = async (
  handle: FileHandle,
  range: { readonly from: number; readonly to: number } | null,
): Promise<{ kept: Map<number, string>; count: number; ended: boolean } | "binary"> => {
  const start = range ? Math.max(1, range.from - contextLines) : 1
  const last = range ? Math.min(range.to + contextLines, start + maxLines - 1) : wholeLines
  const keeps = (line: number) => line <= wholeLines || (line >= start && line <= last)
  const kept = new Map<number, string>()
  // The latest lines read, which a range past the file's end is pulled back to.
  const tail: [number, string][] = []
  const decoder = new StringDecoder("utf8")
  const breaks = /\r\n|\r|\n/g
  const buffer = Buffer.alloc(chunkBytes)
  let count = 0
  let line = ""
  // A carriage return ended the last chunk, so a line feed opening the next is its pair.
  let carriage = false
  let position = 0
  // Where the last kept line ended, past which only `textBudget` more is read.
  let past: number | undefined
  const push = () => {
    count += 1
    if (keeps(count)) kept.set(count, line)
    tail.push([count, line])
    if (tail.length > contextLines + 1) tail.shift()
    if (count === last) past = position
    line = ""
  }
  const take = (text: string) => {
    let at = carriage && text.startsWith("\n") ? 1 : 0
    breaks.lastIndex = at
    for (let found = breaks.exec(text); found; found = breaks.exec(text)) {
      line = (line + text.slice(at, found.index)).slice(0, maxLineChars)
      push()
      at = breaks.lastIndex
    }
    line = (line + text.slice(at)).slice(0, maxLineChars)
    if (text.length > 0) carriage = text.endsWith("\r")
  }
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- One chunk after another.
    const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position)
    if (bytesRead === 0) break
    const chunk = buffer.subarray(0, bytesRead)
    if (position < sniffBytes && chunk.subarray(0, sniffBytes - position).includes(0))
      return "binary"
    position += bytesRead
    take(decoder.write(chunk))
    if (past !== undefined && position - past > textBudget) return { kept, count, ended: false }
  }
  take(decoder.end())
  // The line a final newline ends is the last; an empty file has one empty line.
  if (line !== "" || count === 0) push()
  for (const [number, text] of tail) kept.set(number, text)
  return { kept, count, ended: true }
}

/**
 * An image or a text file, as it is now, symlinks resolved. One that may hold secrets is
 * `held` unless `reveal`; an image past the preview limit is `too-large`; a text file
 * with a NUL byte near its start is `binary`. A text file is read up to a budget, then
 * shown around its lines.
 */
export const loadFile = async (
  item: Pick<ItemRecord, "kind" | "path" | "lines" | "held">,
  reveal: boolean,
): Promise<ItemContent> => {
  if (item.path === null) return unavailable("missing")
  let path: string
  try {
    path = await realpath(item.path)
  } catch (error) {
    return unavailable(reasonOf(error))
  }
  let opened: Awaited<ReturnType<typeof openPlain>>
  try {
    opened = await openPlain(path)
  } catch (error) {
    return unavailable(reasonOf(error))
  }
  if ("state" in opened) return opened
  const { handle, stats } = opened
  try {
    if ((item.held || secret(path)) && !reveal) return unavailable("held", stats.size)
    const stamp = stampOf(stats)
    if (item.kind === "image") {
      if (stats.size > maxImageBytes) return unavailable("too-large", stats.size)
      const { bytes, more } = await readUpTo(handle, maxImageBytes)
      if (more) return unavailable("too-large", stats.size)
      const mime = images[extname(path).toLowerCase()] ?? "application/octet-stream"
      return {
        state: "ready",
        stamp,
        content: { kind: "image", src: `data:${mime};base64,${bytes.toString("base64")}` },
      }
    }
    const read = await readLines(handle, item.lines)
    if (read === "binary") return unavailable("binary", stats.size)
    const { kept, count, ended } = read
    const window = captureWindow(count, item.lines)
    const lines: string[] = []
    for (let line = window.first; line <= window.last; line += 1) lines.push(kept.get(line) ?? "")
    return {
      state: "ready",
      stamp,
      content: {
        kind: "file",
        path: clip(path, 4096),
        firstLine: window.first,
        lines,
        from: window.from,
        to: window.to,
        total: ended ? count : null,
        truncated: !ended,
        // Only lines past the file's end are pulled back, never those past what was read.
        clamped: ended && window.clamped,
      },
    }
  } catch (error) {
    return unavailable(reasonOf(error))
  } finally {
    await handle.close().catch(() => {})
  }
}

/** A plan's text, cut short past what the protocol takes, and when it last changed. */
export type PlanText = {
  readonly text: string
  readonly truncated: boolean
  readonly changedAt: number | null
}

/** A plan's file as it stands, or undefined while it is not there, or not a file. */
export const readPlanFile = async (
  path: string,
): Promise<(PlanText & { readonly stamp: string }) | undefined> => {
  try {
    // A pipe or device put in a plan's place never blocks the reader.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) return undefined
      const { bytes, more } = await readUpTo(handle, maxPlanBytes)
      // A character cut at the limit is left out rather than mangled.
      const text = new StringDecoder("utf8").write(bytes)
      return { text, truncated: more, changedAt: Math.round(stats.mtimeMs), stamp: stampOf(stats) }
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

// What was last read of each transcript or rollout holding text plans, by its path: the
// file it was, as far as it was read, and the latest plan it held there. Such a file is
// only appended to, so a later read decodes only what was added since.
type Decoded = {
  readonly stamp: string
  readonly ino: number
  readonly born: number
  /** How far it was read, to the end of its last whole line, and the bytes just before. */
  readonly offset: number
  readonly mark: Buffer
  /** The latest plan its whole lines held, from which a later read goes on. */
  readonly settled: PlanText | undefined
  /** The latest plan, a last line without its newline yet included. */
  readonly plan: PlanText | undefined
}
// How many bytes before where a file was read to tell it is still the same file.
const markBytes = 256
const decoded = new Map<string, Decoded>()
const maxDecoded = 16
// The read under way of each path; another waits for it, then reads only what is new.
const decoding = new Map<string, Promise<PlanText | undefined>>()

/**
 * The latest plan presented as text that a transcript or rollout records, read with its
 * harness's own decoders; undefined when the file is gone or records none.
 */
export const readTextPlan = (agent: AgentName, path: string): Promise<PlanText | undefined> => {
  const plans = harnesses[agent].plans
  if (!plans) return Promise.resolve(undefined)
  const before = decoding.get(path) ?? Promise.resolve(undefined)
  const read = before.then(() => decodePlans(path, plans))
  decoding.set(path, read)
  void read.finally(() => {
    if (decoding.get(path) === read) decoding.delete(path)
  })
  return read
}

/**
 * Whether a file is still the one read before, only grown: the same file, at least as
 * long, holding the same bytes just before where that read ended.
 */
const sameFile = async (handle: FileHandle, stats: Stats, known: Decoded): Promise<boolean> => {
  if (stats.ino !== known.ino || stats.birthtimeMs !== known.born) return false
  if (stats.size < known.offset) return false
  const mark = Buffer.alloc(known.mark.length)
  const { bytesRead } = await handle.read(mark, 0, mark.length, known.offset - mark.length)
  return bytesRead === mark.length && mark.equals(known.mark)
}

const decodePlans = async (
  path: string,
  plans: NonNullable<(typeof harnesses)[AgentName]["plans"]>,
): Promise<PlanText | undefined> => {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch {
    return undefined
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return undefined
    const stamp = stampOf(stats)
    const known = decoded.get(path)
    if (known?.stamp === stamp) return known.plan
    // The same file, grown: only what was added. Replaced or cut short: all of it again.
    const from = known && (await sameFile(handle, stats, known)) ? known : undefined
    let latest = from?.settled
    let position = from?.offset ?? 0
    let carry = Buffer.alloc(0)
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- One chunk after another.
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position + carry.length)
      if (bytesRead === 0) break
      const data = Buffer.concat([carry, buffer.subarray(0, bytesRead)])
      const end = data.lastIndexOf(10)
      // Only whole lines: one still being written is read once it ends.
      if (end < 0) {
        carry = data
        continue
      }
      for (const line of data.subarray(0, end).toString("utf8").split("\n"))
        for (const { source, at } of plans(line.endsWith("\r") ? line.slice(0, -1) : line))
          if (source.kind === "text")
            latest = { text: source.text, truncated: source.truncated, changedAt: at }
      position += end + 1
      carry = data.subarray(end + 1)
    }
    const settled = latest
    // A last line without its newline counts, though a later read takes it again.
    for (const { source, at } of plans(carry.toString("utf8").replace(/\r$/, "")))
      if (source.kind === "text")
        latest = { text: source.text, truncated: source.truncated, changedAt: at }
    const mark = Buffer.alloc(Math.min(markBytes, position))
    await handle.read(mark, 0, mark.length, position - mark.length)
    decoded.delete(path)
    decoded.set(path, {
      stamp,
      ino: stats.ino,
      born: stats.birthtimeMs,
      offset: position,
      mark,
      settled,
      plan: latest,
    })
    for (const oldest of decoded.keys()) {
      if (decoded.size <= maxDecoded) break
      decoded.delete(oldest)
    }
    return latest
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => {})
  }
}

/** A plan's text, as `content` yields it, stamped by its text. */
export const planReady = (plan: PlanText): ItemContent => ({
  state: "ready",
  stamp: hashOf(plan.text),
  content: { kind: "plan", ...plan },
})

/**
 * A plan's content: its file as it stands, or for one presented as text, the latest its
 * transcript or rollout records, unless `live` already has it. `gone` once neither does.
 */
export const loadPlan = async (
  item: Pick<ItemRecord, "path" | "plan">,
  live: PlanText | undefined,
): Promise<ItemContent> => {
  if (item.path === null || item.plan === null) return unavailable("gone")
  if (item.plan.format === "file") {
    const plan = await readPlanFile(item.path)
    if (!plan) return unavailable("gone")
    const { stamp, ...text } = plan
    return { state: "ready", stamp, content: { kind: "plan", ...text } }
  }
  const plan = live ?? (await readTextPlan(item.plan.agent, item.path))
  return plan ? planReady(plan) : unavailable("gone")
}

/**
 * A plan's title: its first heading, or its file's name when it has none; undefined while
 * its file can't be read.
 */
export const planTitle = async (source: PlanSource): Promise<string | undefined> => {
  const text = source.kind === "text" ? source.text : (await readPlanFile(source.path))?.text
  if (text === undefined) return undefined
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text)?.[1]
  return heading ?? (source.kind === "file" ? basename(source.path) : undefined)
}

/**
 * What says an item may read differently now, cheaply: its file's stamp, or what `live`
 * has of a text plan. Content is read again, and compared, only when this changes.
 */
export const probe = async (
  item: Pick<ItemRecord, "kind" | "path" | "plan">,
  live: PlanText | undefined,
): Promise<string> => {
  if (item.kind === "page" || item.path === null) return ""
  const file = await stat(item.path).then(stampOf, () => "")
  return live ? `${file}|${hashOf(live.text)}` : file
}
