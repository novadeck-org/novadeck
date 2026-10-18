// First, so its `@layer` order statement leads the bundle.
import "../styles.css"
import { App } from "../app/App"
import type { BackendSelection } from "../backend/port"
import { start } from "./start"

// The desktop app: the runner the host starts, whose client and terminal emulator load with
// the connection instead of the entry point.
const runner: BackendSelection = {
  connect: async (signal, progress) => {
    const { connectRunnerBackend, desktopTransport } = await import("../backend/runner")
    return connectRunnerBackend(signal, progress, desktopTransport)
  },
}

start(<App selection={runner} />)
