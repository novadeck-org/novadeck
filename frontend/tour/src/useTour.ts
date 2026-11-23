import type { AgentName } from "@novadeck/core/harnesses"
import type { AgentConnection } from "@novadeck/core/port"
import { useCallback, useMemo, useState } from "react"

import {
  offerTour,
  startingTour,
  tourAgent,
  tourAgentState,
  tourFailed,
  type TourAgentState,
  type TourConsent,
} from "./consent"
import { startTour, type TourEffects, type TourStarted } from "./start"
import type { TourHost } from "./tour-host"

export type TourOffer = {
  // The consent while it is offered, null otherwise.
  readonly consent: TourConsent | null
  // Where opencode stands for the tour: ready, being connected, to connect, or to install.
  readonly agent: TourAgentState
  readonly offer: () => void
  readonly start: () => void
  // Connects Novadeck to opencode, installed but not yet connected, as its switch in Preferences does.
  readonly connect: () => void
  readonly close: () => void
}

/**
 * The tour as the app offers it: the consent, and starting the run once the person agrees.
 * The consent closes once the tour's project and terminal are open; one the backend refused
 * stays open with its reason. Absent (`undefined`) where the backend has no tour.
 */
export const useTour = (
  { backend, commands }: Pick<TourHost, "backend" | "commands">,
  connections: readonly AgentConnection[],
  // A run started, for the tour's driver to follow.
  onStarted: (agent: AgentName, started: TourStarted) => void,
): TourOffer | undefined => {
  const [consent, setConsent] = useState<TourConsent | null>(null)
  const { tour } = backend
  const refresh = backend.agents?.refresh
  const set = backend.agents?.set
  const agent = useMemo(() => tourAgentState(connections), [connections])
  const offer = useCallback(() => {
    // One already starting stays as it is.
    setConsent((current) => (current?.starting ? current : offerTour()))
    // A program installed or removed since the agents were last looked at shows or goes.
    void refresh?.()
  }, [refresh])
  const start = useCallback(() => {
    if (!tour || !consent || consent.starting || agent.step !== "ready") return
    setConsent(startingTour(consent))
    const effects: TourEffects = {
      tour,
      openTour: commands.openTour,
      add: (options) => commands.add(options),
    }
    startTour(effects).then(
      (started) => {
        setConsent(null)
        onStarted(tourAgent, started)
      },
      (error: unknown) => setConsent((current) => current && tourFailed(current, error)),
    )
  }, [tour, consent, agent, commands, onStarted])
  return useMemo(
    () =>
      tour && {
        consent,
        agent,
        offer,
        start,
        connect: () => set?.(tourAgent, true),
        close: () => setConsent((current) => (current?.starting ? current : null)),
      },
    [tour, consent, agent, offer, start, set],
  )
}
