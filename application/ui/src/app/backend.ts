import { createBootRehearsals } from "../backend/boot-rehearsal"
import { createDemoBackend } from "../backend/demo"
import { createContentDemo } from "../backend/demo/content"
import { createDemoPortable } from "../backend/demo/debug/portable"
import { createDemoSandbox, sampleFix } from "../backend/demo/debug/sandbox"
import { createDemoUpdates, sampleNotes } from "../backend/demo/debug/updates"
import type { BackendSelection, ConnectBackend } from "../backend/port"
import type { InstallResult } from "../model/portable"
import type { SandboxState } from "../model/sandbox"
import { createStore } from "../model/store"
import type { UpdateOffer } from "../model/update"

// The only place that chooses a backend adapter. Tests and specs run on the demo;
// every build, development or production, connects to a runner, whose client and
// terminal emulator load with the connection instead of the entry point. The content
// preview connects to the demo, with its debug panel; the `try` mode, a build for a
// website's visitors, to the demo that plays itself.
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
  // `&outdated=recent` or `&outdated=old` dates when this copy learned of the release,
  // two or twenty days back.
  const outdated = query.get("outdated")
  const days = outdated === "recent" ? 2 : outdated === "old" ? 20 : undefined
  const outdatedSince =
    days === undefined ? undefined : new Date(Date.now() - days * 86_400_000).toISOString()
  return (
    kind && {
      kind,
      version: "0.0.80",
      notes: sampleNotes,
      ...(outdatedSince ? { outdatedSince } : {}),
    }
  )
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

// Specs open the demo on a portable copy with `?portable=on`, and choose how installing
// ends with `&install=newer` or `&install=failed`; it never ends otherwise.
const requestedInstall = (): InstallResult | undefined => {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  if (query.get("portable") !== "on") return undefined
  const install = query.get("install")
  if (install === "newer") return { kind: "newer", version: "0.0.99" }
  if (install === "failed") return { kind: "failed", reason: "There is no space left." }
  return { kind: "installing" }
}

// `&answer=late` makes the host take 4 seconds to say it is a portable copy.
const answerDelay = (): number =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("answer") === "late" ? 4000 : 0

// Specs open the demo as a visitor's, with `?visitor=on`: the strip, the hints and the
// narrow window's panel the app shows for one. Its scenario is the visitor backend's own.
const visitorRequested = (): boolean =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("visitor") === "on"

const testBackend = (): ReturnType<typeof createDemoBackend> => {
  if (visitorRequested())
    return { ...createDemoBackend(), visitor: { answered: createStore(false) } }
  if (showcaseRequested()) return createContentDemo()
  const update = requestedUpdate()
  const sandbox = requestedSandbox()
  const install = requestedInstall()
  const demo = update ? demoWithUpdate(update) : createDemoBackend()
  const withSandbox = sandbox ? { ...demo, sandbox: createDemoSandbox(sandbox) } : demo
  return install
    ? {
        ...withSandbox,
        portable: createDemoPortable({ install, answerAfterMs: answerDelay() }).portable,
      }
    : withSandbox
}

// The visitor build, for a website, loads its demo with the connection, so no other build
// carries it.
const visitorSelection = (): BackendSelection => ({
  connect: async (signal, progress) =>
    (await import("../backend/demo/visitor/connect")).connectVisitor(signal, progress),
})

export const selectBackend: BackendSelection =
  import.meta.env.MODE === "content-preview"
    ? demoSelection()
    : import.meta.env.MODE === "try"
      ? visitorSelection()
      : import.meta.env.MODE === "test"
        ? { createBackend: testBackend }
        : runnerSelection()
