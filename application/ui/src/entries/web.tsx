// First, so its `@layer` order statement leads the bundle.
import "../styles.css"
import { App } from "../app/App"
import type { BackendSelection } from "../backend/port"
import { start } from "./start"

// The app in a browser (`pnpm dev:web`): a runner over a WebSocket, whose client and terminal
// emulator load with the connection instead of the entry point.
const runner: BackendSelection = {
  connect: async (signal, progress) =>
    (await import("../backend/runner")).connectRunnerBackend(signal, progress),
}

start(<App selection={runner} />)
