// First, so its `@layer` order statement leads the bundle.
import "@novadeck/ui/styles.css"
import type { BackendSelection } from "@novadeck/core/port"
import { App } from "@novadeck/ui/app/App"
import { start } from "@novadeck/ui/entries/start"
import { pageTheme } from "@novadeck/ui/theme/source"

// The app in a browser (`pnpm dev:web`): a runner over a WebSocket, whose client and terminal
// emulator load with the connection instead of the entry point.
const runner: BackendSelection = {
  connect: async (signal, progress) => {
    const { connectRunnerBackend, webTransport } = await import("@novadeck/runner-adapter")
    return connectRunnerBackend(signal, progress, { transport: webTransport, theme: pageTheme })
  },
}

start(<App selection={runner} />)
