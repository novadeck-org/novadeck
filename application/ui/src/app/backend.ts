import { createBootRehearsals } from "../backend/boot-rehearsal"
import type { BackendSelection, ConnectBackend } from "../backend/port"

// The only place that chooses a build's backend adapter. Every build, development or
// production, connects to a runner, whose client and terminal emulator load with the
// connection instead of the entry point. The content preview connects to the demo, with its
// debug panel; the `try` mode, a build for a website's visitors, to the demo without it.
// Tests and specs pass App the demo's spec backend themselves (backend/demo/spec-variants.ts).
const runnerSelection = (): BackendSelection => ({
  connect: async (signal, progress) =>
    (await import("../backend/runner")).connectRunnerBackend(signal, progress),
})

// The content preview's demo, with its debug panel, loads with the connection too, so
// no build for a runner carries it.
const demoSelection = (): BackendSelection => {
  const rehearsals = createBootRehearsals()
  // One connection for every attempt, as it remembers the variant and what the panel
  // armed. Attempts at once share its load; one that failed is tried again by the next.
  let loading: Promise<ConnectBackend> | undefined
  const load = (): Promise<ConnectBackend> =>
    (loading ??= import("../backend/demo/debug/connect").then(
      ({ connectDemo }) => connectDemo(rehearsals),
      (error: unknown) => {
        loading = undefined
        throw error
      },
    ))
  return {
    connect: async (signal, progress) => (await load())(signal, progress),
    reboots: rehearsals.reboots,
  }
}

// The visitor build, for a website, loads its demo with the connection, so no other build
// carries it.
const visitorSelection = (): BackendSelection => ({
  connect: async (signal, progress) =>
    (await import("../backend/demo/visitor/connect")).connectVisitor(signal, progress),
})

// Tests and specs hand App the demo's spec backend; one that forgets fails at once, saying
// so, rather than waiting on a runner that never comes.
const testSelection: BackendSelection = {
  createBackend: () => {
    throw new Error("Pass App createBackend from backend/demo/spec-variants.ts in tests")
  },
}

export const selectBackend: BackendSelection =
  import.meta.env.MODE === "content-preview"
    ? demoSelection()
    : import.meta.env.MODE === "try"
      ? visitorSelection()
      : import.meta.env.MODE === "test"
        ? testSelection
        : runnerSelection()
