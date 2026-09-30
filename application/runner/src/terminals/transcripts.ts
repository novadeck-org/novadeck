import type { TranscriptChange } from "@novadeck/protocol"

import { followLines } from "../harnesses/follow.js"
import type { Harness } from "../harnesses/harness.js"

// Items per change, as the protocol takes them, and how many may wait unread before the
// file's reading pauses.
const batch = 256
const backlog = 4 * batch

/**
 * An actor's transcript as changes: every item from the start of `path`, then each one
 * appended, in batches, with `reset` when the file is rewritten; until `signal` aborts.
 */
export const transcriptChanges = async function* (
  path: string,
  items: NonNullable<Harness["transcripts"]>["items"],
  outer: AbortSignal,
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
  const reading = followLines(
    path,
    signal,
    (line) => {
      for (const item of items(line)) {
        collected.push({ ...item, index })
        index += 1
        queued += 1
        if (collected.length === batch) flush()
      }
    },
    {
      fromStart: true,
      onIdle: flush,
      onReset: () => {
        queued -= collected.length
        collected = []
        index = 0
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
