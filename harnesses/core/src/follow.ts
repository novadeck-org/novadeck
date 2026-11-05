import { open, stat } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"

/**
 * The longest line `followLines` passes on, in bytes. A harness does write records over
 * 5 MB (a Codex rollout's large tool output, seen at 5.8 MB), so this leaves wide room
 * while bounding what each reader holds: a longer line is skipped whole, to its line
 * break, and nothing of it is passed on.
 */
export const maxLine = 32 * 1024 * 1024
// How much of a file one read takes, so a large backlog never stalls the runner.
const chunk = 1024 * 1024
// How many of the bytes already read each read takes again, before the new ones: a file
// only appended to still holds them, one rewritten in place mostly doesn't.
const overlap = 64

/**
 * The lines at the end of `path`, its last `bytes` of it, oldest first; the first may be
 * cut short. Undefined when it can't be read.
 */
export const tailLines = async (
  path: string,
  bytes = 256 * 1024,
): Promise<readonly string[] | undefined> => {
  try {
    const file = await open(path, "r")
    try {
      const { size } = await file.stat()
      const start = Math.max(0, size - bytes)
      const buffer = Buffer.alloc(size - start)
      // Fewer where the file shrank since its size was read.
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
      return buffer.subarray(0, bytesRead).toString("utf8").split("\n")
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Calls `onLine` with each line appended to `path`, and where in the file it ends (the
 * byte past its line break), until `signal` aborts, polling every `intervalMs`. A file that
 * already exists is followed from its end: only what is written from now on counts, unless
 * `fromStart` reads it whole first. One that does not exist yet is read from its start once
 * it appears, as an agent may create its transcript after its first hook. A file that
 * shrinks, another put in its place, or one rewritten in place where it was read up to, was
 * rewritten: `onReset` is told, and it is read again from its start. A line over `maxLine`
 * bytes is skipped whole. `onIdle` is told whenever it has read all there is for now, with
 * whether the file was there to read, and each read waits for `pace`, so a slow reader
 * holds it back. A callback that throws loses only its own call: the lines after it, and
 * where they end, are told as ever.
 */
export const followLines = async (
  path: string,
  signal: AbortSignal,
  onLine: (line: string, end: number) => void,
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
    readonly onIdle?: (found: boolean) => void
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
  // The bytes before `offset`, up to `overlap` of them; unknown until the first read where
  // it begins past the start.
  let seen: Buffer | undefined = offset === 0 ? Buffer.alloc(0) : undefined
  // The bytes read of the line not yet ended, and how many; none while it is skipped.
  let parts: Buffer[] = []
  let held = 0
  let skipping = false
  const quietly = (call: () => void) => {
    try {
      call()
    } catch {
      // The reader's own failure: it loses this call alone.
    }
  }
  const restart = () => {
    offset = 0
    seen = Buffer.alloc(0)
    parts = []
    held = 0
    skipping = false
    quietly(() => onReset?.())
  }
  // The lines `data`, read from `base` on, ends, with where each ends; what follows the
  // last line break is held for the next read.
  const split = (data: Buffer, base: number): [string, number][] => {
    const lines: [string, number][] = []
    let from = 0
    for (let at = data.indexOf(0x0a); at !== -1; at = data.indexOf(0x0a, from)) {
      const piece = data.subarray(from, at)
      const length = held + piece.length
      if (!skipping && length <= maxLine) {
        const line = (parts.length === 0 ? piece : Buffer.concat([...parts, piece], length))
          // A character split across reads is whole here, its bytes joined first.
          .toString("utf8")
        if (line) lines.push([line, base + at + 1])
      }
      parts = []
      held = 0
      skipping = false
      from = at + 1
    }
    if (!skipping && from < data.length) {
      const piece = data.subarray(from)
      held += piece.length
      if (held > maxLine) {
        parts = []
        held = 0
        skipping = true
      } else parts.push(piece)
    }
    return lines
  }
  // One poll: reads what was appended since the last; what it read, whether the file was
  // there, and the lines it ended.
  const poll = async (): Promise<{
    read: number
    found: boolean
    lines: [string, number][]
  }> => {
    let rewritten = false
    try {
      const { size, ino } = await stat(path)
      const replaced = file !== undefined && ino !== file
      file = ino
      if (size < offset || replaced) restart()
      if (size <= offset) return { read: 0, found: true, lines: [] }
      const handle = await open(path, "r")
      try {
        const back = Math.min(offset, overlap)
        const buffer = Buffer.alloc(Math.min(size - offset, chunk) + back)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - back)
        const before = buffer.subarray(0, Math.min(back, bytesRead))
        seen ??= Buffer.from(before)
        if (bytesRead < back || !before.equals(seen)) rewritten = true
        else {
          const data = buffer.subarray(back, bytesRead)
          const base = offset
          offset += data.length
          seen =
            data.length >= overlap
              ? Buffer.from(data.subarray(-overlap))
              : Buffer.concat([seen, data]).subarray(-overlap)
          return { read: data.length, found: true, lines: split(data, base) }
        }
      } finally {
        await handle.close()
      }
    } catch {
      // Not there yet, or gone for now: try again.
      return { read: 0, found: false, lines: [] }
    }
    // What it had read is no longer there: read it again from its start.
    if (rewritten) restart()
    return poll()
  }
  while (!signal.aborted) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Each poll follows the one before.
      await pace?.()
    } catch {
      // As a callback that throws: the reading goes on.
    }
    // eslint-disable-next-line no-await-in-loop -- As above.
    const { read, found, lines } = await poll()
    for (const [line, end] of lines) if (!signal.aborted) quietly(() => onLine(line, end))
    // A full chunk may have more behind it.
    if (read === chunk) continue
    if (!signal.aborted) quietly(() => onIdle?.(found))
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(intervalMs, undefined, { signal }).catch(() => {})
  }
}
