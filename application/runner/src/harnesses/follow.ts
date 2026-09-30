import { open, stat } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { setTimeout as sleep } from "node:timers/promises"

// A line longer than this is dropped rather than held: no record a harness writes is.
const maxLine = 4 * 1024 * 1024
// How much of a file one read takes, so a large backlog never stalls the runner.
const chunk = 1024 * 1024

/**
 * Calls `onLine` with each line appended to `path` until `signal` aborts, polling every
 * `intervalMs`. A file that already exists is followed from its end: only what is
 * written from now on counts, unless `fromStart` reads it whole first. One that does not
 * exist yet is read from its start once it appears, as an agent may create its
 * transcript after its first hook. A file that shrinks, or another put in its place,
 * was rewritten: `onReset` is told, and it is read again from its start. `onIdle` is told whenever it has read all there
 * is for now, and each read waits for `pace`, so a slow reader holds it back.
 */
export const followLines = async (
  path: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
  {
    intervalMs = 400,
    fromStart = false,
    onReset,
    onIdle,
    pace,
  }: {
    readonly intervalMs?: number
    readonly fromStart?: boolean
    readonly onReset?: () => void
    readonly onIdle?: () => void
    readonly pace?: () => Promise<void>
  } = {},
): Promise<void> => {
  let offset = fromStart
    ? 0
    : await stat(path).then(
        ({ size }) => size,
        () => 0,
      )
  // Which file it reads, so one put in its place starts over, whatever its size.
  let file: number | undefined
  let decoder = new StringDecoder("utf8")
  let rest = ""
  // One poll: reads what was appended since the last, and says how much it read.
  const poll = async (): Promise<number> => {
    let read = 0
    try {
      const { size, ino } = await stat(path)
      const replaced = file !== undefined && ino !== file
      file = ino
      if (size < offset || replaced) {
        offset = 0
        decoder = new StringDecoder("utf8")
        rest = ""
        onReset?.()
      }
      if (size <= offset) return 0
      const handle = await open(path, "r")
      try {
        const buffer = Buffer.alloc(Math.min(size - offset, chunk))
        ;({ bytesRead: read } = await handle.read(buffer, 0, buffer.length, offset))
        offset += read
        rest += decoder.write(buffer.subarray(0, read))
      } finally {
        await handle.close()
      }
      const lines = rest.split("\n")
      rest = lines.pop() ?? ""
      if (rest.length > maxLine) rest = ""
      for (const line of lines) if (line && !signal.aborted) onLine(line)
    } catch {
      // Not there yet, or gone for now: try again.
    }
    return read
  }
  while (!signal.aborted) {
    // eslint-disable-next-line no-await-in-loop -- Each poll follows the one before.
    await pace?.()
    // eslint-disable-next-line no-await-in-loop -- As above.
    const read = await poll()
    // A full chunk may have more behind it.
    if (read === chunk) continue
    if (!signal.aborted) onIdle?.()
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(intervalMs, undefined, { signal }).catch(() => {})
  }
}
