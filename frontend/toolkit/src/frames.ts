// Work that finishes at its own pace, as code blocks coloured one by one, each drawing again as it
// does: run together in the next frame, it draws once for all of them, as React batches what is
// set in one task.

type Batch = { readonly runs: Set<() => void> }

let pending: Batch | null = null

const flush = (batch: Batch): void => {
  if (pending === batch) pending = null
  for (const run of batch.runs) run()
}

/** Runs `run` in the next frame with whatever else asked for it; the function returned cancels it. */
export const inNextFrame = (run: () => void): (() => void) => {
  if (pending === null) {
    const batch: Batch = { runs: new Set() }
    pending = batch
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => flush(batch))
    else setTimeout(() => flush(batch), 0)
  }
  const batch = pending
  const once = (): void => run()
  batch.runs.add(once)
  return () => {
    batch.runs.delete(once)
  }
}
