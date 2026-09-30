import { constants } from "node:fs"
import { open, stat } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"

import type { PlanContent } from "@novadeck/protocol"

import type { PlanSource } from "../harnesses/events.js"

// The most of a plan's file read, as the protocol takes it.
const maxBytes = 256 * 1024

/**
 * What says a plan changed: a file's size and when it last changed, or undefined while
 * it is not there or not a plain file; a text never changes.
 */
export const planStamp = (source: PlanSource): Promise<string | undefined> =>
  source.kind === "text"
    ? Promise.resolve("text")
    : stat(source.path).then(
        (stats) => (stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : undefined),
        () => undefined,
      )

/** A plan's text as it stands, or undefined while its file is not there, or not a file. */
export const planContent = async (
  ref: string,
  source: PlanSource,
): Promise<PlanContent | undefined> => {
  if (source.kind === "text")
    return { ref, text: source.text, truncated: source.truncated, changedAt: null }
  try {
    // A pipe or device put in a plan's place never blocks the reader.
    const handle = await open(source.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) return undefined
      const { size, mtimeMs } = stats
      const buffer = Buffer.alloc(Math.min(size, maxBytes))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      // A character cut at the limit is left out rather than mangled.
      const text = new StringDecoder("utf8").write(buffer.subarray(0, bytesRead))
      return { ref, text, truncated: size > bytesRead, changedAt: Math.round(mtimeMs) }
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}
