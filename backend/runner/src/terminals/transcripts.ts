import { followLines } from "@novadeck/harness-core/follow"
import type { Harness, TranscriptEntry } from "@novadeck/harness-core/harness"
import { interruptionEntry } from "@novadeck/harness-core/items"
import type { TranscriptChange } from "@novadeck/protocol"

import type { Record } from "./record.js"

// Items per change, as the protocol takes them, and how many may wait unread before the
// file's reading pauses.
const batch = 256
const backlog = 4 * batch

/**
 * Where the person interrupted a turn that the transcript itself doesn't record, as
 * Antigravity's writes no step for an Escape: how long the file was when they pressed it,
 * and when.
 */
export type Interruption = { readonly offset: number; readonly at: number }

/**
 * The interruptions a terminal keeps for an actor of its bound session, by its native id:
 * the root's alone, as only the root's turn is the person's to interrupt.
 */
export const interruptionsOf =
  (record: Pick<Record, "bound" | "interruptions">, native: string | null) =>
  (): readonly Interruption[] =>
    native === null
      ? (record.interruptions ?? []).filter(
          (each) => each.sessionId === record.bound?.binding.sessionId,
        )
      : []

/**
 * An actor's transcript as changes: every item from the start of `path`, then each one
 * appended, in batches, with `reset` when the file is rewritten; until `signal` aborts.
 * Each of `interruptions` joins them as its item before the person's first item the file got
 * after it, or once all it had then is read: after the turn's last steps, as the words a
 * harness writes just after the key (Antigravity's, up to 0.1 s on), before the next prompt.
 * One told only after the next prompt was read joins at the end, and in its place once the
 * transcript is read again.
 */
export const transcriptChanges = async function* (
  path: string,
  items: NonNullable<Harness["transcripts"]>["items"],
  outer: AbortSignal,
  interruptions: () => readonly Interruption[] = () => [],
): AsyncGenerator<TranscriptChange> {
  // Its own, so leaving early stops the reading as `outer` aborting does.
  const controller = new AbortController()
  const { signal } = controller
  const stop = () => controller.abort()
  outer.addEventListener("abort", stop, { once: true })
  if (outer.aborted) stop()
  const queue: TranscriptChange[] = []
  let collected: Extract<TranscriptChange, { type: "items" }>["items"][number][] = []
  let index = 0
  let queued = 0
  // Where the lines read so far end, and the interruptions told since the file was read
  // from its start.
  let position = 0
  const told = new Set<string>()
  let wake: (() => void) | undefined
  let resume: (() => void) | undefined
  const notify = () => {
    const waiting = wake
    wake = undefined
    waiting?.()
  }
  const flush = () => {
    if (collected.length === 0) return
    queue.push({ type: "items", items: collected })
    collected = []
    notify()
  }
  const collect = (item: TranscriptEntry) => {
    collected.push({ ...item, index })
    index += 1
    queued += 1
    if (collected.length === batch) flush()
  }
  // The interruptions the file had all its lines for by `upTo`, oldest first.
  const interrupted = (upTo: number) => {
    for (const each of interruptions().toSorted((a, b) => a.offset - b.offset)) {
      const key = `${each.offset}:${each.at}`
      if (each.offset > upTo || told.has(key)) continue
      told.add(key)
      collect(interruptionEntry(each.at))
    }
  }
  const reading = followLines(
    path,
    signal,
    (line, end) => {
      const read = items(line)
      if (read.some((item) => item.role === "user")) interrupted(position)
      position = end
      for (const item of read) collect(item)
    },
    {
      fromStart: true,
      onIdle: () => {
        interrupted(position)
        flush()
      },
      onReset: () => {
        queued -= collected.length
        collected = []
        index = 0
        position = 0
        told.clear()
        queue.push({ type: "reset" })
        notify()
      },
      pace: () =>
        queued <= backlog || signal.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) => (resume = resolve)),
    },
  )
  const abort = () => {
    notify()
    resume?.()
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    while (!signal.aborted) {
      const next = queue.shift()
      if (!next) {
        // eslint-disable-next-line no-await-in-loop -- Waits for the file to grow.
        await new Promise<void>((resolve) => (wake = resolve))
        continue
      }
      if (next.type === "items") queued -= next.items.length
      if (queued <= backlog) {
        const paused = resume
        resume = undefined
        paused?.()
      }
      yield next
    }
  } finally {
    outer.removeEventListener("abort", stop)
    controller.abort()
    signal.removeEventListener("abort", abort)
    await reading
  }
}
