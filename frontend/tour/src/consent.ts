import type { AgentName } from "@novadeck/core/harnesses"
import type { NovaFetchState } from "@novadeck/core/port"

// The one agent the tour runs: Nova, on a model Novadeck pays for, so none of the
// person's own agents is picked, and the consent never offers a choice.
export const tourAgent: AgentName = "pi"

// The tour's consent, while it is offered: whether it is starting, and why it couldn't, in the
// backend's words (Nova's model service refusing a free ticket, say).
export type TourConsent = {
  readonly starting: boolean
  readonly error?: string
}

// Where Pi's download stands for the tour, in words: `waiting` while it is not in place yet (not
// asked for, or under way), `failed` with why, and `ready` to start.
export type TourAgentNote = {
  readonly step: "waiting" | "ready" | "failed"
  readonly text?: string
}

const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1)

export const tourAgentNote = (fetch: NovaFetchState): TourAgentNote => {
  switch (fetch.state) {
    case "ready":
      return { step: "ready" }
    case "failed":
      return { step: "failed", text: fetch.error || "Pi's download failed." }
    case "downloading":
      return {
        step: "waiting",
        text:
          fetch.received !== undefined && fetch.size !== undefined
            ? `Downloading Pi: ${megabytes(fetch.received)} of ${megabytes(fetch.size)} MB`
            : "Downloading Pi…",
      }
    default:
      // Nova switched on, and the runner hasn't said yet.
      return { step: "waiting", text: "Downloading Pi…" }
  }
}

export const offerTour = (): TourConsent => ({ starting: false })

export const startingTour = (consent: TourConsent): TourConsent => {
  const { error: _error, ...rest } = consent
  return { ...rest, starting: true }
}

// An error about starting is about the state Pi was in as it came: once that changes (a download
// that failed now ready, a retry under way), it no longer says anything true, and goes.
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
