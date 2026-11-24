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
// backend knows one; `update` where it is older than Novadeck works with and `unsupported` where
// it is newer than Novadeck knows, as Preferences says of them, where the tour can't follow it.
// `error` is why the last connect didn't take, in the backend's words.
export type TourAgentState = {
  readonly step: "ready" | "connecting" | "connect" | "install" | "update" | "unsupported"
  readonly installer?: string
  readonly error?: string
}

export const tourAgentState = (connections: readonly AgentConnection[]): TourAgentState => {
  const found = connections.find(({ agent }) => agent === tourAgent)
  if (!found?.available)
    return {
      step: "install",
      ...(found?.installer !== undefined && { installer: found.installer }),
    }
  if (found.limited === "outdated") return { step: "update" }
  if (found.limited === "unsupported") return { step: "unsupported" }
  if (found.connected) return { step: "ready" }
  return {
    step: found.busy ? "connecting" : "connect",
    ...(found.error !== undefined && !found.busy && { error: found.error }),
  }
}

export const offerTour = (): TourConsent => ({ starting: false })

export const startingTour = (consent: TourConsent): TourConsent => {
  const { error: _error, ...rest } = consent
  return { ...rest, starting: true }
}

// An error about starting is about the state opencode was in as it came: once that changes (a
// Connect that took, an install that ended), it no longer says anything true, and goes.
export const agentChanged = (consent: TourConsent): TourConsent => {
  if (consent.starting || consent.error === undefined) return consent
  const { error: _stale, ...rest } = consent
  return rest
}

export const tourFailed = (consent: TourConsent, error: unknown): TourConsent => ({
  ...consent,
  starting: false,
  error: error instanceof Error && error.message ? error.message : "The tour couldn't start.",
})
