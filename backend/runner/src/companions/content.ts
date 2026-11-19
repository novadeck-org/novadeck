import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, open, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { StringDecoder } from "node:string_decoder"

import type { PlanSource } from "@novadeck/harness-core/events"
import {
  companionLimits,
  isDataPath,
  type AgentName,
  type ItemContent,
  type PlanSaveResult,
  type PlanUnwritable,
  type FilePart,
  modelFormats,
  modelLimits,
  modelRefusal,
  partBytes,
  pdfLimits,
  videoLimits,
} from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { harnesses } from "../harnesses/registry.js"
import { cut, tail } from "../text.js"
import type { ItemRecord } from "./records.js"
import { failure, type RequestFailure } from "./request.js"
import { folderSecrets, secret } from "./secrets.js"

// What is shown as an image, by extension: what Chromium decodes itself, as the desktop app
// and a browser both are, JPEG XL among them (probed in Electron 45.2.2, Chromium 156). HEIC,
// TIFF and gzipped SVG aren't, so they stay files.
const images: { readonly [extension: string]: string } = {
  ".png": "image/png",
  ".apng": "image/apng",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".jfif": "image/jpeg",
  ".pjpeg": "image/jpeg",
  ".pjp": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jxl": "image/jxl",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".cur": "image/x-icon",
  ".svg": "image/svg+xml",
}
// What is played as a video, by extension: what Chromium plays, as the desktop app and a
// browser both are. A QuickTime file plays where its codec is one of those.
const videos: { readonly [extension: string]: string } = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
}
// What is played as a recording, by extension, as above.
const recordings: { readonly [extension: string]: string } = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
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
// What the protocol takes of a plan, which a plan's file is read up to in bytes.
const maxPlanBytes = companionLimits.plan

/** What an item's content reads of a pointer: unavailable, with why, or ready. */
type Unavailable = Extract<ItemContent, { state: "unavailable" }>
const unavailable = (reason: Unavailable["reason"], size: number | null = null): Unavailable => ({
  state: "unavailable",
  reason,
  size,
})

/** Whether a file is shown as an image, by its extension. */
export const isImage = (path: string): boolean => images[extname(path).toLowerCase()] !== undefined

/** Whether a file is played as a video, by its extension. */
export const isVideo = (path: string): boolean => videos[extname(path).toLowerCase()] !== undefined

/** Whether a file is played as a recording, by its extension. */
export const isAudio = (path: string): boolean =>
  recordings[extname(path).toLowerCase()] !== undefined

/** Whether a file is previewed as a PDF, by its extension. */
export const isPdf = (path: string): boolean => extname(path).toLowerCase() === ".pdf"

// The formats a person names otherwise than by their extension: JPEG's other extensions are
// JPEG, JPEG XL is spelt out, and a glTF model is glTF in its text form or its binary one, as
// its pane names it.
const formatNames: { readonly [extension: string]: string } = {
  ".jpg": "JPEG",
  ".jpe": "JPEG",
  ".jfif": "JPEG",
  ".pjpeg": "JPEG",
  ".pjp": "JPEG",
  ".jxl": "JPEG XL",
  ".gltf": "glTF",
  ".glb": "glTF",
}

/** A file's format as a person names it, by its extension: "JPEG" for a.jfif, "PNG" for a.png. */
export const formatOf = (path: string): string => {
  const extension = extname(path).toLowerCase()
  return formatNames[extension] ?? extension.slice(1).toUpperCase()
}

/** A 3D model's format, by its file's extension; undefined for any other file. */
const modelFormatOf = (path: string): (typeof modelFormats)[number] | undefined => {
  const extension = extname(path).toLowerCase().slice(1)
  return modelFormats.find((format) => format === extension)
}

/** Whether a file is a 3D model the pane draws, by its extension. */
export const isModel = (path: string): boolean => modelFormatOf(path) !== undefined

/**
 * How a file is shown, by its extension: as an image, played as a video or a recording,
 * drawn as a PDF or as a 3D model, or read.
 */
const kindOf = (path: string): Pointed["kind"] =>
  isImage(path)
    ? "image"
    : isVideo(path)
      ? "video"
      : isAudio(path)
        ? "audio"
        : isPdf(path)
          ? "pdf"
          : modelFormatOf(path)
            ? "model"
            : "file"

/**
 * Whether the start of a file holds a NUL byte, as a binary file does; undefined where it can't
 * be read (gone, locked, no plain file).
 */
const startsBinary = async (path: string): Promise<boolean | undefined> => {
  try {
    const opened = await openPlain(path)
    if ("state" in opened) return undefined
    try {
      const head = Buffer.alloc(sniffBytes)
      const { bytesRead } = await opened.handle.read(head, 0, sniffBytes, 0)
      return head.subarray(0, bytesRead).includes(0)
    } finally {
      await opened.handle.close().catch(() => {})
    }
  } catch {
    return undefined
  }
}

/**
 * Whether a file named as a Wavefront model (.obj) is a compiled object file instead, as MSVC's
 * compiler writes: one starts with its machine's type, in binary, where a model is text. Only its
 * start is read; undefined where it can't be, which tells nothing yet.
 */
export const isCompiledObject = async (path: string): Promise<boolean | undefined> =>
  extname(path).toLowerCase() === ".obj" ? await startsBinary(path) : false

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
  const last = Math.min(total, to + contextLines, first + companionLimits.lines - 1)
  return { first, last, from, to: Math.min(to, last), clamped }
}

/** What a path points at, once checked the cheap way, as show and attach take it. */
export type Pointed = {
  readonly ok: true
  /** Its path, symlinks resolved. */
  readonly path: string
  readonly kind: "image" | "video" | "audio" | "pdf" | "model" | "file" | "folder"
  readonly size: number
  readonly secret: boolean
}

/**
 * A file or a folder a request points at, from the terminal's directory: anything but a
 * missing path, or a pipe or device. A folder that may hold secrets is refused: it is never
 * listed. What it holds is read only as it loads. `env` is
 * the person's environment, which says where tools keep their logins (see `secret`).
 */
export const pointAt = async (
  given: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<Pointed | RequestFailure> => {
  const path = await realpath(resolve(cwd, given)).catch(() => undefined)
  if (!path) return failure("That file doesn't exist.")
  const stats = await stat(path).catch(() => undefined)
  if (!stats) return failure("That file doesn't exist.")
  if (stats.isDirectory()) {
    if (folderSecrets(env)(path))
      return failure("That folder may hold secrets, so Novadeck won't list what is in it.")
    return { ok: true, path, kind: "folder", size: 0, secret: false }
  }
  if (!stats.isFile())
    return failure("Only files and folders can be shown, not a pipe or a device.")
  const kind = kindOf(path)
  return {
    ok: true,
    path,
    // A compiled object file is an .obj too, which no model is.
    kind: kind === "model" && (await isCompiledObject(path)) === true ? "file" : kind,
    size: stats.size,
    secret: secret(path, env),
  }
}

/**
 * A page, by its address: any http(s) page, which the desktop app loads in its own
 * locked-down browser view. An address carrying a user name or password is refused,
 * as it would show them.
 */
export const pageAt = (
  address: string,
): { readonly ok: true; readonly url: URL } | RequestFailure => {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return failure("That isn't a valid address.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return failure("Novadeck shows only http and https pages.")
  if (url.username || url.password)
    return failure("Novadeck won't show an address with a user name or password in it.")
  // Encoding can lengthen it past what the protocol carries.
  if (url.href.length > companionLimits.url) return failure("That address is too long.")
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
export const stampOf = (stats: Stats): string => `${stats.size}:${stats.mtimeMs}:${stats.ino}`

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
  const last = range
    ? Math.min(range.to + contextLines, start + companionLimits.lines - 1)
    : wholeLines
  const keeps = (line: number) => line <= wholeLines || (line >= start && line <= last)
  const kept = new Map<number, string>()
  // The latest lines read, which a range past the file's end is pulled back to.
  const trailing: [number, string][] = []
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
    // One unit past the limit is held, to see whether it falls inside a pair.
    const recorded = cut(line, companionLimits.lineLength)
    if (keeps(count)) kept.set(count, recorded)
    trailing.push([count, recorded])
    if (trailing.length > contextLines + 1) trailing.shift()
    if (count === last) past = position
    line = ""
  }
  const take = (text: string) => {
    let at = carriage && text.startsWith("\n") ? 1 : 0
    breaks.lastIndex = at
    for (let found = breaks.exec(text); found; found = breaks.exec(text)) {
      line = (line + text.slice(at, found.index)).slice(0, companionLimits.lineLength + 1)
      push()
      at = breaks.lastIndex
    }
    line = (line + text.slice(at)).slice(0, companionLimits.lineLength + 1)
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
  for (const [number, text] of trailing) kept.set(number, text)
  return { kept, count, ended: true }
}

/**
 * A data file's lines from line `start` (its first by default), read as its preview reads
 * it, as a whole: every line whole, as many as `companionLimits.data` holds, in UTF-16 code
 * units and a unit for each line's break, which its UTF-8 bytes are never fewer than;
 * `ended` once that's all of them,
 * and `count`, the lines read in all. A line the limit stops inside is left out, unless
 * it's the first kept, which comes cut short, so the file shows something. Lines before
 * `start` are counted, not kept. A NUL byte near its start makes it binary.
 */
const readWhole = async (
  handle: FileHandle,
  start = 1,
): Promise<{ lines: string[]; ended: boolean; count: number } | "binary"> => {
  const decoder = new StringDecoder("utf8")
  const breaks = /\r\n|\r|\n/g
  const buffer = Buffer.alloc(chunkBytes)
  const budget = companionLimits.data
  const lines: string[] = []
  let size = 0
  let count = 0
  // The line being read, held only once it's one to keep, and whether any of it came.
  let line = ""
  let begun = false
  // A carriage return ended the last chunk, so a line feed opening the next is its pair.
  let carriage = false
  let position = 0
  const keeping = (): boolean => count + 1 >= start
  // Whether the line being read still fits, its break counted, so no more lines come than
  // the limit; once one doesn't, the read stops there.
  const fits = (): boolean => {
    if (size + line.length + 1 <= budget) return true
    if (lines.length === 0) lines.push(line.slice(0, budget))
    return false
  }
  const end = (): boolean => {
    if (keeping()) {
      if (!fits()) return false
      lines.push(line)
      size += line.length + 1
    }
    count += 1
    line = ""
    begun = false
    return true
  }
  const take = (text: string): boolean => {
    let at = carriage && text.startsWith("\n") ? 1 : 0
    breaks.lastIndex = at
    for (let found = breaks.exec(text); found; found = breaks.exec(text)) {
      if (keeping()) line += text.slice(at, found.index)
      if (!end()) return false
      at = breaks.lastIndex
    }
    if (at < text.length) begun = true
    if (keeping()) line += text.slice(at)
    if (text.length > 0) carriage = text.endsWith("\r")
    // A line still being read stops the read once it's past the limit: none has begun after
    // a break that ends the text.
    return !keeping() || !begun || fits()
  }
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- One chunk after another.
    const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position)
    if (bytesRead === 0) break
    const chunk = buffer.subarray(0, bytesRead)
    if (position < sniffBytes && chunk.subarray(0, sniffBytes - position).includes(0))
      return "binary"
    position += bytesRead
    if (!take(decoder.write(chunk))) return { lines, ended: false, count }
  }
  if (!take(decoder.end())) return { lines, ended: false, count }
  // The line a final newline ends is the last; an empty file has one empty line.
  if ((begun || count === 0) && !end()) return { lines, ended: false, count }
  return { lines, ended: true, count }
}

/**
 * A data file's lines as its item shows them: from its start, or, when the lines pointed at
 * lie past what its start's budget holds, from a little before them, as a text file's
 * window is; from its last lines when they lie past its end.
 */
const readData = async (
  handle: FileHandle,
  pointed: { readonly from: number; readonly to: number } | null,
): Promise<{ first: number; lines: string[]; ended: boolean; count: number } | "binary"> => {
  const whole = await readWhole(handle)
  if (whole === "binary" || whole.ended || !pointed || pointed.to < whole.lines.length)
    return whole === "binary" ? whole : { first: 1, ...whole }
  const first = Math.max(1, pointed.from - contextLines)
  const around = await readWhole(handle, first)
  if (around === "binary" || around.lines.length > 0)
    return around === "binary" ? around : { first, ...around }
  const last = Math.max(1, around.count - contextLines)
  const end = await readWhole(handle, last)
  return end === "binary" ? end : { first: last, ...end }
}

/** The lines pointed at, pulled into the lines read, `first` to `last`, and whether they were. */
const pointedAt = (
  first: number,
  last: number,
  lines: { readonly from: number; readonly to: number } | null | undefined,
): { from: number; to: number; clamped: boolean } => {
  const from = Math.max(first, Math.min(lines?.from ?? first, last))
  const to = Math.max(from, Math.min(lines?.to ?? last, last))
  return {
    from,
    to,
    clamped: lines !== null && lines !== undefined && (from !== lines.from || to !== lines.to),
  }
}

/**
 * An image or a text file, as it is now, symlinks resolved. One that may hold secrets is
 * `secret` unless `reveal`; an image past the preview limit is `too-large`; a text file
 * with a NUL byte near its start is `binary`. A text file is read up to a budget, then
 * shown around its lines; a data file (`isDataPath`), as a whole from its start, up to
 * its own budget.
 */
export const loadFile = async (
  item: Pick<ItemRecord, "kind" | "path" | "lines" | "secret">,
  reveal: boolean,
  env?: NodeJS.ProcessEnv,
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
    if ((item.secret || secret(path, env)) && !reveal) return unavailable("secret", stats.size)
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
    if (isDataPath(path)) {
      const read = await readData(handle, item.lines)
      if (read === "binary") return unavailable("binary", stats.size)
      const { first, lines, ended, count } = read
      const pointed = pointedAt(first, first + lines.length - 1, item.lines)
      return {
        state: "ready",
        stamp,
        content: {
          kind: "file",
          path: tail(path, companionLimits.path),
          firstLine: first,
          lines,
          from: pointed.from,
          to: pointed.to,
          total: ended ? count : null,
          truncated: !ended,
          // Only lines past the file's end are pulled back, never those past what was read.
          clamped: ended && pointed.clamped,
        },
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
        path: tail(path, companionLimits.path),
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

/**
 * A video or a recording, as it is now, symlinks resolved: its format and size, never its
 * bytes, which `readPart` reads as the client plays it. Its stamp is the file's own, which each part
 * is read against. One that may hold secrets is `secret` unless `reveal`; one past what the
 * pane plays is `too-large`. `shown` is its item's version, and `at` the second its latest
 * show starts it at.
 */
export const loadPlayed = async (
  item: Pick<ItemRecord, "kind" | "path" | "secret">,
  reveal: boolean,
  show: { readonly shown: number; readonly at: number | undefined },
  env?: NodeJS.ProcessEnv,
): Promise<ItemContent> => {
  const file = await partsFile(item, reveal, videoLimits.bytes, env)
  if ("state" in file) return file
  const { path, stats } = file
  return {
    state: "ready",
    stamp: stampOf(stats),
    content: {
      kind: item.kind === "audio" ? "audio" : "video",
      mime: mimeOf(path, item.kind),
      size: stats.size,
      shown: show.shown,
      ...(show.at !== undefined && { at: show.at }),
    },
  }
}

/** A played file's format, by its extension, or by its kind where that names none. */
const mimeOf = (path: string, kind: ItemRecord["kind"]): string => {
  const extension = extname(path).toLowerCase()
  return (
    (kind === "audio" ? recordings[extension] : videos[extension]) ??
    (kind === "audio" ? "audio/mpeg" : "video/mp4")
  )
}

/**
 * A PDF, as it is now, symlinks resolved: its size, never its bytes, which `readPart` reads
 * for the client to draw. As a video's, its stamp is the file's own, one that may hold secrets
 * is `secret` unless `reveal`, and one past what the pane takes is `too-large`.
 */
export const loadPdf = async (
  item: Pick<ItemRecord, "path" | "secret">,
  reveal: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<ItemContent> => {
  const file = await partsFile(item, reveal, pdfLimits.bytes, env)
  if ("state" in file) return file
  return {
    state: "ready",
    stamp: stampOf(file.stats),
    content: { kind: "pdf", size: file.stats.size },
  }
}

// The most of a GLB's JSON chunk, or of a material library, that is read to find the files it
// names; one larger names none.
const maxNamingBytes = 16 * 1024 * 1024

/** A file a model names, as it is read: its path, symlinks resolved, and its stamp. */
export type ModelFile = { readonly path: string; readonly stamp: string }

/** A 3D model as it loads, and the files it names, each by the name the model writes it as. */
export type ModelLoad = {
  readonly content: ItemContent
  readonly files: ReadonlyMap<string, ModelFile>
}

/** The stamps of the files a model's read listed, as they are now, in order: none for one gone. */
export const filesStamps = (files: ModelLoad["files"]): Promise<string[]> =>
  Promise.all([...files.values()].map((file) => stat(file.path).then(stampOf, () => "")))

/** The stamp a model's file is as now, or undefined when it can't be read. */
export const modelStamp = async (item: Pick<ItemRecord, "path">): Promise<string | undefined> => {
  if (item.path === null) return undefined
  try {
    const stats = await stat(await realpath(item.path))
    return stats.isFile() ? stampOf(stats) : undefined
  } catch {
    return undefined
  }
}

/**
 * A 3D model, as it is now, symlinks resolved: its format and size, never its bytes, which
 * `readPart` reads for the client to draw; and the files it names (see `discoverModel`). Its
 * stamp is the model file's own. One that may hold secrets is `secret` unless `reveal`, and
 * one past what the pane takes is `too-large`.
 */
export const loadModel = async (
  item: Pick<ItemRecord, "path" | "secret">,
  reveal: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<ItemContent> => (await discoverModel(item, reveal, env)).content

/**
 * A model and the files it names, each checked as the client will ask for it, by the name
 * the model writes, which is its key. A `data:` name is embedded and left out. One with an
 * address of its own is `external`; one that leaves the model's folder, by its path or by a
 * symlink, is `outside`; then it is `missing`, `not-a-file` or `secret`, or `too-large` once
 * the model and the files read so far pass `modelLimits.bytes`. A file beside a model is never
 * revealed, whatever `reveal`. Past `modelLimits.files` names, the rest are left out. An
 * OBJ's material libraries are read for the textures they name, from their own folder.
 */
export const discoverModel = async (
  item: Pick<ItemRecord, "path" | "secret">,
  reveal: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<ModelLoad> => {
  const model = await partsFile(item, reveal, modelLimits.bytes, env)
  if ("state" in model) return { content: model, files: new Map() }
  const { path, stats } = model
  const format = modelFormatOf(path)
  if (!format) return { content: unavailable("unreadable", stats.size), files: new Map() }
  const folder = dirname(path)
  const listed = new Map<string, ModelFile & { readonly size: number }>()
  const refused = new Map<string, (typeof modelRefusal.options)[number]>()
  const seen = new Set<string>()
  let total = stats.size

  // One name, as written, read from `from` under the model's folder; the file's real path
  // once it is listed.
  const take = async (name: string, from: string): Promise<string | undefined> => {
    const key = from === "" || isExternal(name) ? name : `${from}/${name}`
    if (/^data:/i.test(name) || seen.has(key) || seen.size >= modelLimits.files) return undefined
    seen.add(key)
    // A name past any path is none: told, cut short, as what the protocol takes.
    if (key.length > companionLimits.path) {
      refused.set(`${key.slice(0, companionLimits.path - 1)}…`, "unreadable")
      return undefined
    }
    const found = await beside(folder, from, name, format === "gltf" || format === "glb", env)
    if ("refusal" in found) {
      refused.set(key, found.refusal)
      return undefined
    }
    if (total + found.stats.size > modelLimits.bytes) {
      refused.set(key, "too-large")
      return undefined
    }
    total += found.stats.size
    listed.set(key, { path: found.path, stamp: stampOf(found.stats), size: found.stats.size })
    return found.path
  }

  try {
    if (format === "gltf" || format === "glb") {
      // eslint-disable-next-line no-await-in-loop -- Each file counts against what the last left.
      for (const uri of await gltfUris(path, format)) await take(uri, "")
    } else if (format === "obj") {
      for (const library of await objLibraries(path)) {
        // eslint-disable-next-line no-await-in-loop -- Each library's textures count against what the last left.
        const real = await take(library, "")
        if (real === undefined) continue
        const from = dirname(library.replaceAll("\\", "/"))
        // eslint-disable-next-line no-await-in-loop -- As above.
        for (const texture of await mtlTextures(real)) await take(texture, from === "." ? "" : from)
      }
    }
  } catch {
    // What can't be read names nothing more.
  }
  return {
    content: {
      state: "ready",
      stamp: stampOf(stats),
      content: {
        kind: "model",
        format,
        size: stats.size,
        files: [...listed].map(([name, file]) => ({ name, size: file.size, stamp: file.stamp })),
        refused: [...refused].map(([name, reason]) => ({ name, reason })),
      },
    },
    files: new Map(
      [...listed].map(([name, file]) => [name, { path: file.path, stamp: file.stamp }]),
    ),
  }
}

/** Whether a name has an address of its own: a scheme, a drive, or a root. */
const isExternal = (name: string): boolean =>
  /^[\\/]/.test(name) || /^[a-z][a-z0-9+.-]*:/i.test(name)

/** Whether a path is inside a folder, or is it. */
const within = (folder: string, path: string): boolean => {
  const from = relative(folder, path)
  return from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from)
}

/**
 * The file a model names beside it: `name` from `from`, a folder under the model's `folder`,
 * its path and stats, or why not (see `discoverModel`). A glTF's names are percent-encoded;
 * an OBJ's and its materials' are as written.
 */
const beside = async (
  folder: string,
  from: string,
  name: string,
  encoded: boolean,
  env: NodeJS.ProcessEnv | undefined,
): Promise<
  | { readonly path: string; readonly stats: Stats }
  | { readonly refusal: (typeof modelRefusal.options)[number] }
> => {
  if (isExternal(name)) return { refusal: "external" }
  let relativeName = name
  if (encoded) {
    try {
      relativeName = decodeURIComponent(name)
    } catch {
      return { refusal: "missing" }
    }
  }
  // Either slash leaves a folder on Windows, and a name is the same one on every system.
  if (relativeName.includes("\0")) return { refusal: "missing" }
  const target = resolve(folder, from, ...relativeName.split(/[\\/]/))
  if (!within(folder, target)) return { refusal: "outside" }
  let path: string
  let stats: Stats
  try {
    path = await realpath(target)
    if (!within(folder, path)) return { refusal: "outside" }
    stats = await stat(path)
  } catch (error) {
    const reason = reasonOf(error)
    return { refusal: reason === "missing" ? "missing" : "unreadable" }
  }
  if (!stats.isFile()) return { refusal: "not-a-file" }
  if (secret(path, env) || secret(target, env)) return { refusal: "secret" }
  return { path, stats }
}

/** The addresses a glTF's buffers and images name, in the order the file gives them. */
// The `"uri"` strings of a glTF's text, found without parsing it: each value, but one that
// holds its data itself (`data:`), which is passed over, or one past any path.
const scanUris = (text: Buffer): string[] => {
  const uris: string[] = []
  let at = text.indexOf('"uri"')
  while (at >= 0) {
    const start = text.indexOf('"', text.indexOf(":", at + 5) + 1)
    if (start < 0) break
    const close = text.indexOf('"', start + 1)
    if (close < 0) break
    if (!text.subarray(start + 1, start + 6).equals(Buffer.from("data:")) && close - start <= 4096)
      uris.push(JSON.parse(text.toString("utf8", start, close + 1)) as string)
    at = text.indexOf('"uri"', close + 1)
  }
  return uris
}

const gltfUris = async (path: string, format: "gltf" | "glb"): Promise<string[]> => {
  const opened = await openPlain(path)
  if ("state" in opened) return []
  const { handle, stats } = opened
  try {
    let json: Buffer
    if (format === "gltf") {
      json = Buffer.alloc(stats.size)
      await readFully(handle, json, 0)
      // One too large to parse at once, as a glTF holding its data in itself: its addresses
      // found in its bytes, the data it holds skipped over.
      if (stats.size > maxNamingBytes) return scanUris(json)
    } else {
      // A GLB's header, then its first chunk, which is the JSON. The length it gives is taken
      // only as far as the file goes and a limit.
      const head = Buffer.alloc(20)
      if ((await readFully(handle, head, 0)) < 20) return []
      if (head.readUInt32LE(0) !== 0x46546c67 || head.readUInt32LE(16) !== 0x4e4f534a) return []
      json = Buffer.alloc(Math.min(head.readUInt32LE(12), stats.size - 20, maxNamingBytes))
      json = json.subarray(0, await readFully(handle, json, 20))
    }
    const parsed: unknown = JSON.parse(json.toString("utf8"))
    return ["buffers", "images"].flatMap((section) => {
      const entries = (parsed as { [key: string]: unknown })[section]
      return Array.isArray(entries)
        ? entries.flatMap((entry: unknown) => {
            const uri = (entry as { uri?: unknown } | null)?.uri
            return typeof uri === "string" ? [uri] : []
          })
        : []
    })
  } catch {
    return []
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Reads from `position` until `buffer` is full or the file ends; how many bytes it got. */
const readFully = async (handle: FileHandle, buffer: Buffer, position: number): Promise<number> => {
  let read = 0
  while (read < buffer.length) {
    // eslint-disable-next-line no-await-in-loop -- One chunk after another.
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, position + read)
    if (bytesRead === 0) break
    read += bytesRead
  }
  return read
}

/**
 * The material libraries an OBJ names, as three.js's OBJLoader reads them: each `mtllib` line
 * gives the rest of the line, trimmed, as one name. A line ends with `\` to go on in the next.
 */
const objLibraries = async (path: string): Promise<string[]> => {
  const opened = await openPlain(path)
  if ("state" in opened) return []
  const { handle } = opened
  const libraries: string[] = []
  const decoder = new StringDecoder("utf8")
  const chunk = Buffer.alloc(chunkBytes)
  let line = ""
  let position = 0
  const finish = (): void => {
    const text = line.trimStart()
    if (text.startsWith("mtllib ")) libraries.push(text.slice(7).trim())
    line = ""
  }
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- One chunk after another.
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      position += bytesRead
      const text = bytesRead === 0 ? decoder.end() : decoder.write(chunk.subarray(0, bytesRead))
      const lines = text.split("\n")
      for (const [index, part] of lines.entries()) {
        line += part
        if (index === lines.length - 1) break
        // Carriage returns end no line, as the loader reads them out first.
        if (line.endsWith("\r")) line = line.slice(0, -1)
        if (line.endsWith("\\")) line = line.slice(0, -1)
        else finish()
      }
      if (bytesRead === 0) break
    }
    finish()
  } finally {
    await handle.close().catch(() => {})
  }
  return libraries
}

// The texture lines of a material library, by the kind of map each sets in three.js's
// MTLLoader: a material takes the first of a kind in the order its lines first name them.
const textureKinds: { readonly [line: string]: string } = {
  map_kd: "map",
  map_ks: "specularMap",
  map_ke: "emissiveMap",
  norm: "normalMap",
  map_bump: "bumpMap",
  bump: "bumpMap",
  disp: "displacementMap",
  map_d: "alphaMap",
}

/**
 * The texture names a material library gives, as three.js 0.187's MTLLoader asks for them: a
 * line's key is lower case and its value the rest of it, trimmed; a repeated key in a
 * material keeps its last value; a material of the same name replaces the one before; and a
 * texture's options (`-bm`, `-mm`, `-s`, `-o`, with the counts of values the loader takes)
 * come out of its value, which is joined again as its name.
 */
const mtlTextures = async (path: string): Promise<string[]> => {
  const opened = await openPlain(path)
  if ("state" in opened) return []
  const { handle, stats } = opened
  try {
    if (stats.size > maxNamingBytes) return []
    const buffer = Buffer.alloc(stats.size)
    const read = await readFully(handle, buffer, 0)
    const materials = new Map<string, Map<string, string>>()
    let info = new Map<string, string>()
    for (const raw of buffer.subarray(0, read).toString("utf8").split("\n")) {
      const line = raw.trim()
      if (line.length === 0 || line.startsWith("#")) continue
      const space = line.indexOf(" ")
      const key = (space >= 0 ? line.slice(0, space) : line).toLowerCase()
      const value = space >= 0 ? line.slice(space + 1).trim() : ""
      if (key === "newmtl") {
        info = new Map()
        materials.set(value, info)
      } else {
        info.set(key, value)
      }
    }
    const names: string[] = []
    for (const material of materials.values()) {
      const kinds = new Set<string>()
      for (const [key, value] of material) {
        const kind = textureKinds[key]
        if (kind === undefined || value === "" || kinds.has(kind)) continue
        kinds.add(kind)
        const name = textureName(value)
        if (name !== "") names.push(name)
      }
    }
    return names
  } finally {
    await handle.close().catch(() => {})
  }
}

/** A texture line's name, as MTLLoader's `getTextureParams` leaves it. */
const textureName = (value: string): string => {
  const items = value.split(/\s+/)
  for (const [option, count] of [
    ["-bm", 2],
    ["-mm", 3],
    ["-s", 4],
    ["-o", 4],
  ] as const) {
    const at = items.indexOf(option)
    if (at >= 0) items.splice(at, count)
  }
  return items.join(" ").trim()
}

/**
 * The file of an item read in parts, symlinks resolved, with its stats; or why it can't be
 * read: not there, no plain file, held as `secret` unless `reveal`, or past `largest` bytes.
 */
const partsFile = async (
  item: Pick<ItemRecord, "path" | "secret">,
  reveal: boolean,
  largest: number,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ readonly path: string; readonly stats: Stats } | Unavailable> => {
  if (item.path === null) return unavailable("missing")
  let path: string
  let stats: Stats
  try {
    path = await realpath(item.path)
    stats = await stat(path)
  } catch (error) {
    return unavailable(reasonOf(error))
  }
  if (!stats.isFile()) return unavailable("not-a-file")
  if ((item.secret || secret(path, env)) && !reveal) return unavailable("secret", stats.size)
  if (stats.size > largest) return unavailable("too-large", stats.size)
  return { path, stats }
}

/** The kinds the client reads in parts, by the largest file each takes, in bytes. */
export const partsOf: { readonly [kind in ItemRecord["kind"]]?: number } = {
  video: videoLimits.bytes,
  audio: videoLimits.bytes,
  pdf: pdfLimits.bytes,
  model: modelLimits.bytes,
}

/**
 * A part of an item's file from `offset`, up to `partBytes` bytes, read only while the
 * file is as `stamp` names it: `changed` once it isn't, as when it was rendered again, so the
 * client starts over from its new content. Past its end, the part is empty. A file past
 * `largest` bytes, the most its kind takes, is `too-large`.
 */
export const readPart = async (
  item: Pick<ItemRecord, "path" | "secret">,
  part: { readonly stamp: string; readonly offset: number },
  reveal: boolean,
  largest: number,
  env?: NodeJS.ProcessEnv,
  // Whether the file opened is still the one asked for, where the caller must know.
  same?: (opened: Stats) => Promise<boolean>,
): Promise<FilePart> => {
  if (item.path === null) return { state: "unavailable", reason: "missing" }
  let path: string
  let opened: Awaited<ReturnType<typeof openPlain>>
  try {
    path = await realpath(item.path)
    opened = await openPlain(path)
  } catch (error) {
    const reason = reasonOf(error)
    return { state: "unavailable", reason: reason === "missing" ? "missing" : unreadable(reason) }
  }
  if ("state" in opened) return { state: "unavailable", reason: "not-a-file" }
  const { handle, stats } = opened
  try {
    if ((item.secret || secret(path, env)) && !reveal)
      return { state: "unavailable", reason: "secret" }
    if (same && !(await same(stats))) return { state: "unavailable", reason: "missing" }
    if (stats.size > largest) return { state: "unavailable", reason: "too-large" }
    if (stampOf(stats) !== part.stamp) return { state: "changed" }
    const length = Math.max(0, Math.min(partBytes, stats.size - part.offset))
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      // eslint-disable-next-line no-await-in-loop -- One chunk after another.
      const { bytesRead } = await handle.read(buffer, read, length - read, part.offset + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    // Written to while it was read: what was read may be half of each.
    const after = await handle.stat()
    if (stampOf(after) !== part.stamp) return { state: "changed" }
    return { state: "part", data: buffer.subarray(0, read).toString("base64") }
  } catch (error) {
    return { state: "unavailable", reason: unreadable(reasonOf(error)) }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** A reason a part can't be read for, of those a part can give. */
const unreadable = (
  reason: Unavailable["reason"],
): Extract<FilePart, { state: "unavailable" }>["reason"] =>
  reason === "not-a-file" || reason === "missing" ? reason : "unreadable"

/** A plan's text, cut short past what the protocol takes, and when it last changed. */
export type PlanText = {
  readonly text: string
  readonly truncated: boolean
  readonly changedAt: number | null
}

/** The error code of a failed file operation, such as `EACCES`. */
const errnoOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

/** Whether an error says a path is not there: nothing to read, rather than a failed read. */
const isMissing = (error: unknown): boolean => {
  const code = errnoOf(error)
  return code === "ENOENT" || code === "ENOTDIR"
}

/**
 * A plan's file as it stands, or undefined while it is not there, or not a file. Any other
 * failure to read it (no permission, too many files open, a failing disk) is raised: it
 * does not say the file is gone.
 */
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
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
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
const planReady = (plan: PlanText): ItemContent => ({
  state: "ready",
  stamp: hashOf(plan.text),
  content: { kind: "plan", ...plan, writable: false, skill: false },
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
    const plan = await readPlanFile(item.path).catch(() => "unreadable" as const)
    if (plan === "unreadable") return unavailable("unreadable")
    if (!plan) return unavailable("gone")
    const { stamp, ...text } = plan
    return {
      state: "ready",
      stamp,
      // One past what is read whole can't be written back without cutting it.
      content: { kind: "plan", ...text, writable: !text.truncated, skill: false },
    }
  }
  const plan = live ?? (await readTextPlan(item.plan.agent, item.path))
  return plan ? planReady(plan) : unavailable("gone")
}

/** What `savePlan` answers: the protocol's, but for whether the plan's agent has the skill. */
type SavedPlan =
  | Extract<PlanSaveResult, { saved: true }>
  | { saved: false; current: Omit<Extract<PlanSaveResult, { saved: false }>["current"], "skill"> }

const renameTries = 3
const renameWait = 100

/**
 * Renames over a plan. Another program holding the plan open (a scanner, an indexer, an
 * editor) makes this fail for a moment on Windows with EPERM, EACCES or EBUSY, so it is
 * tried a few times before giving up.
 */
const renameSettled = async (from: string, to: string): Promise<void> => {
  for (let tried = 1; ; tried++) {
    try {
      // eslint-disable-next-line no-await-in-loop -- One try after another.
      await rename(from, to)
      return
    } catch (error) {
      const code = errnoOf(error)
      if (tried >= renameTries || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY"))
        throw error
      // eslint-disable-next-line no-await-in-loop -- Waits between tries.
      await new Promise((done) => setTimeout(done, renameWait))
    }
  }
}

/** Why a plan can't be written, as `PLAN_UNWRITABLE` carries it. */
const unwritable = (reason: PlanUnwritable["reason"], message: string) =>
  new DomainError("PLAN_UNWRITABLE", message, { reason })

/** Whether the real path `path` is under one of `folders`, which are resolved too; the ones missing hold nothing. */
const inside = async (path: string, folders: readonly string[]): Promise<boolean> => {
  for (const folder of folders) {
    // eslint-disable-next-line no-await-in-loop -- A few folders, one after the other.
    const real = await realpath(folder).catch(() => undefined)
    if (real === undefined) continue
    const way = relative(real, path)
    if (way !== "" && way !== ".." && !way.startsWith(`..${sep}`) && !isAbsolute(way)) return true
  }
  return false
}

/**
 * Writes the person's edit to a plan kept in a file, unless the file is no longer as it
 * was at stamp `basedOn`: then nothing is written and `current` is what it holds now. The
 * text goes to a temporary file beside the plan, which replaces it at once, so a reader
 * sees the old plan or the new, never a part. Only the plan's own regular file is written.
 * What can never succeed is refused as PLAN_UNWRITABLE, saying why: a plan in an agent's
 * transcript, a file that is gone or no longer a plain file, a text or file past 256 KiB,
 * a folder the runner may not write to, an item that is no plan, a file outside `folders`
 * (the project's folder and the agent's own plans folders, compared as the real paths they
 * are, so a link out of them gets nothing). Any other failure, such as
 * a full disk, is not classified: it may pass, so it is raised as it is. The rewritten file
 * keeps its permissions, and no temporary file is left behind.
 */
export const savePlan = async (
  item: Pick<ItemRecord, "path" | "plan">,
  text: string,
  basedOn: string,
  folders: readonly string[],
): Promise<SavedPlan> => {
  if (item.plan === null || item.path === null) throw unwritable("not-a-plan", "That isn't a plan.")
  if (item.plan.format !== "file")
    throw unwritable("transcript", "This plan lives in the agent's messages; it can't be edited.")
  if (text.length > maxPlanBytes || Buffer.byteLength(text) > maxPlanBytes)
    throw unwritable("too-large", "That plan is too long to save.")
  // The file a link points at is the plan; the link is left in place.
  const path = await realpath(item.path).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (path !== undefined && !(await inside(path, folders)))
    throw unwritable(
      "outside",
      "Novadeck saves plans only in the project's folder or the agent's own plans folder.",
    )
  const before = path === undefined ? undefined : await readPlanFile(path)
  if (path === undefined || before === undefined)
    throw unwritable("gone", "The plan's file is gone.")
  if (before.truncated)
    throw unwritable("too-large", "That plan is too long to edit; saving would cut it.")
  if (before.stamp !== basedOn) {
    const { text: now, truncated, stamp } = before
    return { saved: false, current: { stamp, text: now, truncated } }
  }
  const stats = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (!stats?.isFile()) throw unwritable("gone", "The plan's file is gone.")
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  const mode = stats.mode & 0o777
  let renaming = false
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    )
    let written: Stats
    try {
      // The umask clipped the mode it was created with.
      // A file system without modes (FAT, some network shares) refuses; the save goes on.
      await handle.chmod(mode).catch(() => {})
      await handle.writeFile(text)
      await handle.sync()
      written = await handle.stat()
    } finally {
      await handle.close()
    }
    // The agent may have rewritten the plan since it was read: its version stands.
    // A failed read is not the folder refusing: it is raised without its code.
    const now = await readPlanFile(path).catch((error: unknown) => {
      throw new Error("The plan couldn't be read.", { cause: error })
    })
    if (!now) throw unwritable("gone", "The plan's file is gone.")
    if (now.stamp !== before.stamp) {
      await unlink(temporary).catch(() => {})
      const { text: current, truncated, stamp } = now
      return { saved: false, current: { stamp, text: current, truncated } }
    }
    renaming = true
    await renameSettled(temporary, path)
    // Its size, change time and file survive the rename.
    return { saved: true, stamp: stampOf(written) }
  } catch (error) {
    await unlink(temporary).catch(() => {})
    if (error instanceof DomainError) throw error
    const code = errnoOf(error)
    // The folder refuses the runner: saving again won't help. A rename refused after the
    // temporary file was written in that folder is a plan another program holds: it passes.
    if (code === "EROFS" || (!renaming && (code === "EACCES" || code === "EPERM")))
      throw unwritable("folder", "The plan's folder can't be written to.")
    if (code === "ENOENT") throw unwritable("gone", "The plan's file is gone.")
    throw error
  }
}

/**
 * A plan's title: its first heading, or its file's name when it has none; undefined while
 * its file can't be read.
 */
export const planTitle = async (source: PlanSource): Promise<string | undefined> => {
  const text =
    source.kind === "text"
      ? source.text
      : (await readPlanFile(source.path).catch(() => undefined))?.text
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
