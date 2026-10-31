// First, so its `@layer` order statement leads the bundle.
import "@novadeck/ui/styles.css"
import type { BackendSelection } from "@novadeck/core/port"
import { desktopApp } from "@novadeck/protocol/bridge"
import { App } from "@novadeck/ui/app/App"
import { start } from "@novadeck/ui/entries/start"
import { pageTheme } from "@novadeck/ui/theme/source"

import { reportPageErrors } from "./page-errors"

// The main process logs the errors the page doesn't catch.
reportPageErrors(window, desktopApp())

// The desktop app: the runner the app starts, whose client and terminal emulator load with
// the connection instead of the entry point.
const runner: BackendSelection = {
  connect: async (signal, progress) => {
    const { connectRunnerBackend, desktopTransport } = await import("@novadeck/runner-adapter")
    return connectRunnerBackend(signal, progress, { transport: desktopTransport, theme: pageTheme })
  },
}

start(<App selection={runner} />)
