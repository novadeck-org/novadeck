import type { AgentName } from "@novadeck/core/harnesses"
import type { AgentConnection } from "@novadeck/core/port"

// The one agent the tour runs: opencode, on a model Novadeck pays for, so none of the person's
// own agents is picked, and the consent never offers a choice.
export const tourAgent: AgentName = "opencode"

// The tour's consent, while it is offered: whether it is starting, and why it couldn't, in the
// backend's words (its service refusing a free run, say).
export type TourConsent = {
  readonly starting: boolean
  readonly error?: string
}

// Where opencode stands for the tour: `ready` to start; `connecting` while Novadeck is being
// connected to it, which the tour waits for; `connect` where it is installed but Novadeck isn't
// connected to it; `install` where it isn't installed, with the command that installs it where the
// backend knows one.
export type TourAgentState = {
  readonly step: "ready" | "connecting" | "connect" | "install"
  readonly installer?: string
}

export const tourAgentState = (connections: readonly AgentConnection[]): TourAgentState => {
  const found = connections.find(({ agent }) => agent === tourAgent)
  if (!found?.available)
    return {
      step: "install",
      ...(found?.installer !== undefined && { installer: found.installer }),
    }
  if (found.connected) return { step: "ready" }
  return { step: found.busy ? "connecting" : "connect" }
}

export const offerTour = (): TourConsent => ({ starting: false })

export const startingTour = (consent: TourConsent): TourConsent => {
  const { error: _error, ...rest } = consent
  return { ...rest, starting: true }
}

export const tourFailed = (consent: TourConsent, error: unknown): TourConsent => ({
  ...consent,
  starting: false,
  error: error instanceof Error && error.message ? error.message : "The tour couldn't start.",
})
