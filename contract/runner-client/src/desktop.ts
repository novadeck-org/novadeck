import { desktopApp, runnerPortMessage } from "@novadeck/protocol/bridge"
import { WireError } from "@novadeck/wire"
import { brokeredPort, type Transport } from "@novadeck/wire/client"

import type { RunnerErrorCode } from "./errors.js"

/**
 * Reaches the runner bundled with the Novadeck desktop app. Each connection asks the app
 * for a fresh port, so reconnecting also works after the app restarts its runner.
 */
export const desktop = (): Transport =>
  brokeredPort({
    request: (id) => {
      const app = desktopApp()
      if (!app) throw new WireError<RunnerErrorCode>("CLOSED", "No desktop app provides a runner.")
      app.requestRunner(id)
    },
    message: runnerPortMessage,
    // How long a request's port may arrive after it was cancelled, so it can be closed.
    lateAnswerMs: 60_000,
  })
