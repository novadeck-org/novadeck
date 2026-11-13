import { constants } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"

import { companionLimits, type AgentName, type ItemContent } from "@novadeck/protocol"

import type { Shell } from "../harnesses/shells.js"
import { cut } from "../text.js"
import { hashOf } from "./content.js"

/** The background shells of the agent bound in a terminal, as its activity lists them. */
export type PlaceShells = { readonly agent: AgentName; readonly shells: readonly Shell[] }

type Ready = Extract<ItemContent, { state: "ready" }>
type ShellsContent = Extract<Ready["content"], { kind: "shells" }>
type ShellOutput = ShellsContent["shells"][number]["output"]

// How much of a file is read at a time when counting its lines.
const chunkBytes = 64 * 1024
// The most read from a file's end to find its last lines; a line longer than that is cut by it.
const tailBytes = 2 * 1024 * 1024
// How many files' counts are kept, least recently read first out: enough for the shells of
// many terminals, as a file counted afresh every poll costs its whole length.
const keptFiles = 256
// How much of a file just before the counted size is kept as a check that it was not
// rewritten in place.
const checkBytes = 4096

const newline = 10

/** What a shell's detail says of the shells together: "2 running · 1 failed", or "ended". */
export const shellsDetail = (shells: readonly Pick<Shell, "exit">[]): string => {
  const running = shells.filter(({ exit }) => !exit).length
  // An exit with no code (the harness listed the shell gone) is not a failure.
  const failed = shells.filter(({ exit }) => exit && exit.code !== null && exit.code !== 0).length
  const parts = [running > 0 && `${running} running`, failed > 0 && `${failed} failed`].filter(
    (part) => part !== false,
  )
  return parts.length > 0 ? parts.join(" · ") : "ended"
}

/** How many line feeds a file holds from byte `from` to byte `to`. */
const countLineFeeds = async (handle: FileHandle, from: number, to: number): Promise<number> => {
  const buffer = Buffer.alloc(chunkBytes)
  let count = 0
  for (let position = from; position < to;) {
    // eslint-disable-next-line no-await-in-loop -- One chunk after another.
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(chunkBytes, to - position),
      position,
    )
    if (bytesRead === 0) break
    const chunk = buffer.subarray(0, bytesRead)
    for (let at = chunk.indexOf(newline); at !== -1; at = chunk.indexOf(newline, at + 1)) count += 1
    position += bytesRead
  }
  return count
}

/** A stamp of the `checkBytes` of a file that end at byte `to`. */
const checkOf = async (handle: FileHandle, to: number): Promise<string> => {
  const from = Math.max(0, to - checkBytes)
  const buffer = Buffer.alloc(to - from)
  let read = 0
  while (read < buffer.length) {
    // eslint-disable-next-line no-await-in-loop -- One chunk after another.
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, from + read)
    if (bytesRead === 0) break
    read += bytesRead
  }
  return hashOf(buffer.subarray(0, read).toString("latin1"))
}

/** One line of output as a terminal would leave it: what follows the last carriage return. */
const displayed = (bytes: Buffer): string => {
  const text = bytes.toString("utf8").replace(/\r+$/, "")
  return cut(text.slice(text.lastIndexOf("\r") + 1), companionLimits.lineLength)
}

/**
 * The last `shellLines` lines of a file `size` bytes long that holds `lineFeeds` line
 * feeds, read from its end. A line is what a line feed ends, and a last one with none is a
 * line too; `total` counts them all, so the first line read is numbered from the end.
 */
const lastLines = async (
  handle: FileHandle,
  size: number,
  lineFeeds: number,
): Promise<Extract<ShellOutput, { state: "ready" }>> => {
  const start = Math.max(0, size - tailBytes)
  const buffer = Buffer.alloc(size - start)
  let read = 0
  while (read < buffer.length) {
    // eslint-disable-next-line no-await-in-loop -- One chunk after another.
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read)
    if (bytesRead === 0) break
    read += bytesRead
  }
  // A window that starts inside a multi-byte character skips its continuation bytes.
  let skip = 0
  if (start > 0) while (skip < 3 && skip < read && (buffer[skip]! & 0xc0) === 0x80) skip += 1
  const bytes = buffer.subarray(skip, read)
  const ended = bytes.at(-1) === newline
  const total = Math.max(lineFeeds + (size > 0 && !ended ? 1 : 0), 0)
  const lines: string[] = []
  let end = bytes.length - (ended ? 1 : 0)
  while (bytes.length > 0) {
    const at = end <= 0 ? -1 : bytes.lastIndexOf(newline, end - 1)
    // A line the window starts inside of is whole in the file, but not here: kept only when
    // it is all there is.
    if (at < 0 && start > 0 && lines.length > 0) break
    lines.push(displayed(bytes.subarray(at + 1, end)))
    if (at < 0 || lines.length === companionLimits.shellLines) break
    end = at
  }
  lines.reverse()
  return { state: "ready", firstLine: Math.max(1, total - lines.length + 1), lines, total }
}

/**
 * Drops the oldest lines of the largest tails until the lines of all of them together fit
 * `shellsText`; what is dropped moves a tail's `firstLine` on.
 */
const fit = (outputs: ShellOutput[]): void => {
  const sizes = outputs.map((output) =>
    output.state === "ready" ? output.lines.reduce((sum, line) => sum + line.length, 0) : 0,
  )
  let sum = sizes.reduce((all, each) => all + each, 0)
  while (sum > companionLimits.shellsText) {
    let largest = 0
    for (let at = 1; at < sizes.length; at += 1) if (sizes[at]! > sizes[largest]!) largest = at
    const output = outputs[largest]
    if (output?.state !== "ready" || output.lines.length === 0) return
    const dropped = output.lines.shift()!
    outputs[largest] = { ...output, firstLine: output.firstLine + 1 }
    sizes[largest]! -= dropped.length
    sum -= dropped.length
  }
}

/** A file that is there and cannot be read now. */
const unreadable = { output: { state: "unreadable" }, mark: "unreadable" } as const

/** What was known of a file when it was last read. */
type Counted = {
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly lineFeeds: number
  /** A stamp of the last `checkBytes` before `size`, to tell a rewrite from growth. */
  readonly check: string
  readonly output: Extract<ShellOutput, { state: "ready" }>
}

/**
 * The end of background shells' output files, for the item showing them. A file is counted
 * once and then only from where it was last read to its new end, and only its last lines are
 * read, so following a log of many megabytes costs what it grew by; one that shrank or was
 * replaced is counted afresh.
 */
export class ShellTails {
  private readonly counted = new Map<string, Counted>()

  /**
   * What the shells of an agent's terminal have output now: each shell's last lines, within
   * `shellsText` together (the oldest lines of the largest tails go first), and a stamp that
   * changes as a shell or its file does.
   */
  async content(place: PlaceShells): Promise<ItemContent> {
    const read = await Promise.all(
      place.shells.map(({ output }) =>
        output === undefined
          ? { output: { state: "none" } as const, mark: "none" }
          : this.read(output),
      ),
    )
    const outputs = read.map(({ output }) =>
      output.state === "ready" ? { ...output, lines: [...output.lines] } : output,
    )
    fit(outputs)
    const shells = place.shells.map(({ id, command, since, exit }, at) => ({
      id,
      command,
      since,
      exit: exit && { at: exit.at, code: exit.code },
      output: outputs[at]!,
    }))
    const stamp = hashOf(
      JSON.stringify([
        place.agent,
        place.shells.map(({ id, exit }, at) => [id, exit?.at, exit?.code, read[at]!.mark]),
      ]),
    )
    return { state: "ready", stamp, content: { kind: "shells", agent: place.agent, shells } }
  }

  /** A file's end as it is now, and what tells it from another state of the file. */
  private async read(
    path: string,
  ): Promise<{ readonly output: ShellOutput; readonly mark: string }> {
    let handle: FileHandle
    try {
      // A pipe or device put in its place never blocks the reader, nor does a link get followed.
      handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return code === "ENOENT" || code === "ENOTDIR"
        ? { output: { state: "gone" }, mark: "gone" }
        : unreadable
    }
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) return unreadable
      const mark = `${stats.ino}:${stats.size}:${stats.mtimeMs}`
      const before = this.counted.get(path)
      const unchanged =
        before?.ino === stats.ino && before.size === stats.size && before.mtimeMs === stats.mtimeMs
      if (before && unchanged) {
        this.counted.delete(path)
        this.counted.set(path, before)
        return { output: before.output, mark }
      }
      // What was counted holds for a file that only grew: its bytes before the counted size are
      // the ones that were counted, not a rewrite that left it larger.
      const grown =
        before?.ino === stats.ino &&
        before.size < stats.size &&
        before.check === (await checkOf(handle, before.size))
          ? before
          : undefined
      const lineFeeds =
        (grown?.lineFeeds ?? 0) + (await countLineFeeds(handle, grown?.size ?? 0, stats.size))
      const output = await lastLines(handle, stats.size, lineFeeds)
      const check = await checkOf(handle, stats.size)
      this.counted.delete(path)
      this.counted.set(path, {
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        lineFeeds,
        check,
        output,
      })
      for (const old of this.counted.keys()) {
        if (this.counted.size <= keptFiles) break
        this.counted.delete(old)
      }
      return { output, mark }
    } catch {
      return unreadable
    } finally {
      await handle.close().catch(() => {})
    }
  }
}
