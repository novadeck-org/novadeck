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
 * written from now on counts. One that does not exist yet is read from its start once it
 * appears, as an agent may create its transcript after its first hook. A file that
 * shrinks was rewritten, and is read again from its start.
 */
export const followLines = async (
  path: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
  intervalMs = 400,
): Promise<void> => {
  let offset = await stat(path).then(
    ({ size }) => size,
    () => 0,
  )
  let decoder = new StringDecoder("utf8")
  let rest = ""
  // One poll: reads what was appended since the last, and says how much it read.
  const poll = async (): Promise<number> => {
    let read = 0
    try {
      const { size } = await stat(path)
      if (size < offset) {
        offset = 0
        decoder = new StringDecoder("utf8")
        rest = ""
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
    const read = await poll()
    // A full chunk may have more behind it.
    if (read === chunk) continue
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(intervalMs, undefined, { signal }).catch(() => {})
  }
}
