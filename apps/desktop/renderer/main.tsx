// First, so its `@layer` order statement leads the bundle.
import "@novadeck/ui/styles.css"
import type { BackendSelection } from "@novadeck/core/port"
import { desktopApp, isWindowControlsSide } from "@novadeck/protocol/bridge"
import { App } from "@novadeck/ui/app/App"
import { pageTheme } from "@novadeck/ui/app/page-theme"
import { start } from "@novadeck/ui/entries/start"

import { reportPageErrors } from "./page-errors"

// The main process logs the errors the page doesn't catch.
reportPageErrors(window, desktopApp())

// Where the window's own controls sit over the page (macOS, at its start), the page is its title
// bar from its first paint, the boot screens too, and keeps clear of them on their side: see
// `data-window-controls` in the UI's shell styles.
const controlsSide = desktopApp()?.windowControlsSide
if (isWindowControlsSide(controlsSide) && desktopApp()?.onWindowControls)
  document.documentElement.dataset.windowControls = controlsSide

// The desktop app: the runner the app starts, whose client and terminal emulator load with
// the connection instead of the entry point.
const runner: BackendSelection = {
  connect: async (signal, progress) => {
    const { connectRunnerBackend, desktopTransport } = await import("@novadeck/runner-adapter")
    return connectRunnerBackend(signal, progress, { transport: desktopTransport, theme: pageTheme })
  },
}

start(<App selection={runner} />)
