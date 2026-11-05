import { act } from "react"
import { vi } from "vitest"

export { describe as context, describe, expect, it } from "vitest"

// Waits until `check` passes, letting real time and React's updates run between tries: a
// dialog opens and closes on animation frames, as many of them as a loaded machine takes.
export const eventually = (check: () => void): Promise<void> =>
  vi.waitFor(
    async () => {
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
      check()
    },
    { timeout: 3_000, interval: 0 },
  )
