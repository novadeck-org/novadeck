// First, so its `@layer` order statement leads the bundle.
import "../styles.css"
import type { BackendSelection } from "#core/port"

import { App } from "../app/App"
import { pageTheme } from "../theme/source"
import { start } from "./start"

// The desktop app: the runner the host starts, whose client and terminal emulator load with
// the connection instead of the entry point.
const runner: BackendSelection = {
  connect: async (signal, progress) => {
    const { connectRunnerBackend, desktopTransport } = await import("../backend/runner")
    return connectRunnerBackend(signal, progress, { transport: desktopTransport, theme: pageTheme })
  },
}

start(<App selection={runner} />)
