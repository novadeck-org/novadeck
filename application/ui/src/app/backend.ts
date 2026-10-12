import { createBootRehearsals } from "../backend/boot-rehearsal"
import { createDemoBackend } from "../backend/demo"
import { createContentDemo } from "../backend/demo/content"
import { createDemoSandbox, sampleFix } from "../backend/demo/debug/sandbox"
import { createDemoUpdates, sampleNotes } from "../backend/demo/debug/updates"
import type { BackendSelection, ConnectBackend } from "../backend/port"
import type { SandboxState } from "../model/sandbox"
import type { UpdateOffer } from "../model/update"

// The only place that chooses a backend adapter. Tests and specs run on the demo;
// every build, development or production, connects to a runner, whose client and
// terminal emulator load with the connection instead of the entry point. The content
// preview connects to the demo, with its debug panel.
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

// Specs open the content demo, with its agents' plans and artifacts, by adding
// `?demo=showcase` to the address's hash. The address is read when the workspace
// mounts, since each spec sets its own.
const showcaseRequested = (): boolean =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("demo") === "showcase"

// Specs open the demo on a host that has an update waiting with `?demo=update`, one the
// host can't install itself with `?demo=update-available`, or beside another variant
// with `&update=ready` or `&update=available`.
const requestedUpdate = (): UpdateOffer | undefined => {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  const demo = query.get("demo")
  const kind =
    demo === "update" || query.get("update") === "ready"
      ? "ready"
      : demo === "update-available" || query.get("update") === "available"
        ? "available"
        : undefined
  return kind && { kind, version: "0.0.80", notes: sampleNotes }
}

const demoWithUpdate = (update: UpdateOffer): ReturnType<typeof createDemoBackend> => {
  const { updates, offer } = createDemoUpdates()
  offer(update)
  return { ...createDemoBackend(), updates }
}

// Specs open the demo on a host running without its security sandbox with `?sandbox=off`,
// or `?sandbox=off-unfixed` for one with no command to offer.
const requestedSandbox = (): SandboxState | undefined => {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  const sandbox = query.get("sandbox")
  if (sandbox === "off") return { sandboxed: false, fix: sampleFix }
  if (sandbox === "off-unfixed") return { sandboxed: false, fix: "" }
  return undefined
}

const testBackend = (): ReturnType<typeof createDemoBackend> => {
  if (showcaseRequested()) return createContentDemo()
  const update = requestedUpdate()
  const sandbox = requestedSandbox()
  const demo = update ? demoWithUpdate(update) : createDemoBackend()
  return sandbox ? { ...demo, sandbox: createDemoSandbox(sandbox) } : demo
}

export const selectBackend: BackendSelection =
  import.meta.env.MODE === "content-preview"
    ? demoSelection()
    : import.meta.env.MODE === "test"
      ? { createBackend: testBackend }
      : runnerSelection()
