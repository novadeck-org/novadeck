import { runnerPortMessage, type DesktopApp } from "@novadeck/protocol/bridge"
import { WireError } from "@novadeck/wire"
import { brokeredPort, type Transport } from "@novadeck/wire/client"

import type { RunnerErrorCode } from "./errors.js"

/**
 * Reaches the runner bundled with the Novadeck desktop app. Each connection asks the
 * host for a fresh port, so reconnecting also works after the host restarts its runner.
 */
export const desktop = (): Transport =>
  brokeredPort({
    request: (id) => {
      const host = (globalThis as { novadeck?: Partial<DesktopApp> }).novadeck
      if (!host?.requestRunner)
        throw new WireError<RunnerErrorCode>("CLOSED", "No desktop host provides a runner.")
      host.requestRunner(id)
    },
    message: runnerPortMessage,
    // How long a request's port may arrive after it was cancelled, so it can be closed.
    lateAnswerMs: 60_000,
  })
