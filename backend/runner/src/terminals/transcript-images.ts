import { open, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"

import { maxLine } from "@novadeck/harness-core/follow"
import type { ImageSource } from "@novadeck/harness-core/harness"
import { maxTranscriptImageBytes, type TranscriptImageResult } from "@novadeck/protocol"

import { secret } from "../companions/secrets.js"
import { DomainError } from "../errors.js"
import { harnesses } from "../harnesses/registry.js"
import type { Record } from "./record.js"
import { holds } from "./transcripts.js"

// How much of a file one backward read takes while it looks for the start of a line.
const step = 256 * 1024

/**
 * The line of `path` that ends at `end` (the byte past its line break, as `followLines` tells
 * it), or undefined where no line ends there or it is longer than the reader passes on.
 * Only that line is read, backward from its end.
 */
export const lineEndingAt = async (path: string, end: number): Promise<string | undefined> => {
  if (end < 2) return undefined
  const file = await open(path, "r").catch(() => undefined)
  if (!file) return undefined
  try {
    const { size } = await file.stat()
    if (end > size) return undefined
    const last = Buffer.alloc(1)
    await file.read(last, 0, 1, end - 1)
    if (last[0] !== 0x0a) return undefined
    const parts: Buffer[] = []
    let held = 0
    for (let to = end - 1; to > 0;) {
      const from = Math.max(0, to - step)
      const buffer = Buffer.alloc(to - from)
      // eslint-disable-next-line no-await-in-loop -- Each read goes further back than the last.
      const { bytesRead } = await file.read(buffer, 0, buffer.length, from)
      const chunk = buffer.subarray(0, bytesRead)
      const at = chunk.lastIndexOf(0x0a)
      const piece = at === -1 ? chunk : chunk.subarray(at + 1)
      parts.unshift(piece)
      held += piece.length
      if (held > maxLine) return undefined
      if (at !== -1) break
      to = from
    }
    return Buffer.concat(parts).toString("utf8")
  } catch {
    return undefined
  } finally {
    await file.close()
  }
}

// The formats the chat shows, by their first bytes.
const formatOf = (
  head: Buffer,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined => {
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png"
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg"
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif"
  if (
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp"
  return undefined
}

const unavailable = (reason: "gone" | "too-large" | "unreadable"): TranscriptImageResult => ({
  state: "unavailable",
  reason,
})

const ready = (bytes: Buffer): TranscriptImageResult => {
  const mime = formatOf(bytes)
  return mime
    ? { state: "ready", mime, src: `data:${mime};base64,${bytes.toString("base64")}` }
    : unavailable("unreadable")
}

// The bytes inline in a record, as base64: refused past the limit before any is decoded.
const inline = (base64: string): TranscriptImageResult => {
  const padding = /=*$/.exec(base64)![0].length
  if (Math.floor((base64.length * 3) / 4) - padding > maxTranscriptImageBytes)
    return unavailable("too-large")
  return ready(Buffer.from(base64, "base64"))
}

// A file the session saved, only if it lies under `folder` (its uploads) once links are
// resolved, is a plain file within the limit, and isn't one that may hold secrets.
const saved = async (file: string, folder: string | undefined): Promise<TranscriptImageResult> => {
  if (!folder || !isAbsolute(file)) return unavailable("gone")
  const [home, real] = await Promise.all([
    realpath(folder).catch(() => undefined),
    realpath(file).catch(() => undefined),
  ])
  if (!home || !real) return unavailable("gone")
  const inside = relative(home, real)
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return unavailable("gone")
  if (secret(real)) return unavailable("unreadable")
  try {
    const { size, isFile } = await stat(real).then((one) => ({
      size: one.size,
      isFile: one.isFile(),
    }))
    if (!isFile) return unavailable("unreadable")
    if (size > maxTranscriptImageBytes) return unavailable("too-large")
    const handle = await open(real, "r")
    try {
      const buffer = Buffer.alloc(Math.min(size, maxTranscriptImageBytes) + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      // It grew past the limit since the check.
      if (bytesRead > maxTranscriptImageBytes) return unavailable("too-large")
      return ready(buffer.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    return unavailable("unreadable")
  }
}

/**
 * A prompt image of the terminal's bound session, found again in its own transcript: the line
 * that ends at `offset`, and the `index`th image its harness reads in it. Never a path the
 * caller names: a record's inline bytes, or a file the harness's record names that lies in the
 * session's uploads (`imageFolder`), and either only as a PNG, JPEG, GIF or WebP of at most
 * `maxTranscriptImageBytes`, by its first bytes. A terminal with no session, a line that is no
 * longer there or holds no such image is NOT_FOUND.
 */
export const transcriptImage = async (
  record: Pick<Record, "bound" | "transcript">,
  { offset, index }: { readonly offset: number; readonly index: number },
): Promise<TranscriptImageResult> => {
  const { bound, transcript: root } = record
  const source = bound && harnesses[bound.binding.agent].transcripts
  if (!bound || !source || !root) throw new DomainError("NOT_FOUND")
  const path = await source.locate(root, bound.binding.sessionId, null)
  if (!path || !holds(record.bound?.binding, bound.binding)) throw new DomainError("NOT_FOUND")
  const line = await lineEndingAt(path, offset)
  const image: ImageSource | undefined = line === undefined ? undefined : source.images(line)[index]
  if (!image) throw new DomainError("NOT_FOUND")
  return "base64" in image
    ? inline(image.base64)
    : saved(image.file, source.imageFolder?.(path, bound.binding.sessionId))
}
