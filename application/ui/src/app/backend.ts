import { createBootRehearsals } from "../backend/boot-rehearsal"
import { createDemoBackend } from "../backend/demo"
import { createContentDemo } from "../backend/demo/content"
import type { BackendSelection } from "../backend/port"
import { desktopHost } from "../backend/runner/desktop-host"

// Whether this launch offers the debug panel: the desktop host says so (always in
// development, in a packaged app only with --debug-panel or NOVADECK_DEBUG=1); a browser
// build offers it only in Vite's development server.
const debugPanel = (): boolean => {
  const host = desktopHost()
  return host ? host.debug === true : import.meta.env.DEV
}

// The only place that chooses a backend adapter. Tests and specs run on the demo;
// every build, development or production, connects to a runner, whose client and
// terminal emulator load with the connection instead of the entry point.
const runnerSelection = (): BackendSelection => {
  const rehearsals = debugPanel() ? createBootRehearsals() : undefined
  return {
    connect: async (signal, progress) =>
      (await import("../backend/runner")).connectRunnerBackend(signal, progress, rehearsals),
    ...(rehearsals ? { reboots: rehearsals.reboots } : {}),
  }
}

// Specs open the content demo, with its agents' plans and artifacts, by adding
// `?demo=showcase` to the address's hash. The address is read when the workspace
// mounts, since each spec sets its own.
const showcaseRequested = (): boolean =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("demo") === "showcase"

export const selectBackend: BackendSelection =
  import.meta.env.MODE === "content-preview"
    ? { createBackend: createContentDemo }
    : import.meta.env.MODE === "test"
      ? { createBackend: () => (showcaseRequested() ? createContentDemo() : createDemoBackend()) }
      : runnerSelection()
