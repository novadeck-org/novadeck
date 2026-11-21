import type { AgentName } from "@novadeck/core/harnesses"
import type { AgentConnection, Backend } from "@novadeck/core/port"
import { useCallback, useMemo, useState } from "react"

import {
  chooseAgent,
  connectingAgent,
  followAgents,
  offerTour,
  startingTour,
  tourAgents,
  tourFailed,
  type TourConsent,
} from "../tour/consent"
import { startTour, type TourEffects, type TourStarted } from "../tour/start"
import { useWorkspaceServices } from "./controller/context"

export type TourOffer = {
  // The consent while it is offered, null otherwise.
  readonly consent: TourConsent | null
  // The agents the tour can run now.
  readonly agents: readonly AgentName[]
  // Whether the consent's agent is still being connected, so it can't start yet.
  readonly connecting: boolean
  // Offers the tour, on `preferred` where it can run it.
  readonly offer: (preferred?: AgentName) => void
  readonly choose: (agent: AgentName) => void
  readonly start: () => void
  // Starts the agent the tour needs started first, in a terminal of the project on screen, for
  // the person to sign in to; the consent closes, to be offered again once it has.
  readonly startAgent: (agent: AgentName) => void
  readonly close: () => void
}

/**
 * The tour as the app offers it: the consent, and starting the run once the person agrees.
 * The consent closes once the tour's project and terminal are open; one the backend refused
 * stays open with its reason. Absent (`undefined`) where the backend has no tour.
 */
export const useTour = (
  backend: Pick<Backend, "tour" | "agents">,
  connections: readonly AgentConnection[],
  // A run started, for the tour's driver to follow.
  onStarted: (agent: AgentName, started: TourStarted) => void,
): TourOffer | undefined => {
  const { commands } = useWorkspaceServices()
  const [offered, setConsent] = useState<TourConsent | null>(null)
  const { tour } = backend
  const refresh = backend.agents?.refresh
  // As the connections stand now: an agent that disconnects while it is offered is no longer
  // offered, and the one it was offered on is taken once it connects.
  const consent = useMemo(
    () => offered && followAgents(offered, connections),
    [offered, connections],
  )
  const offer = useCallback(
    (preferred?: AgentName) => {
      // One already starting stays as it is.
      setConsent((current) => (current?.starting ? current : offerTour(connections, preferred)))
      // A program installed or removed since the agents were last looked at shows or goes, as
      // the consent follows the connections while it is open.
      void refresh?.()
    },
    [connections, refresh],
  )
  const start = useCallback(() => {
    if (!tour || !consent?.agent || consent.starting) return
    if (connectingAgent(connections, consent.agent)) return
    setConsent(startingTour(consent))
    const effects: TourEffects = {
      tour,
      openTour: commands.openTour,
      add: (options) => commands.add(options),
    }
    const agent = consent.agent
    startTour(agent, effects).then(
      (started) => {
        setConsent(null)
        onStarted(agent, started)
      },
      (error: unknown) => setConsent((current) => current && tourFailed(current, error)),
    )
  }, [tour, consent, connections, commands, onStarted])
  const agents = useMemo(() => tourAgents(connections), [connections])
  const connecting = connectingAgent(connections, consent?.agent ?? null)
  return useMemo(
    () =>
      tour && {
        consent,
        agents,
        connecting,
        offer,
        choose: (agent: AgentName) =>
          setConsent((current) => current && chooseAgent(current, agent)),
        start,
        startAgent: (agent: AgentName) => {
          setConsent(null)
          commands.add({ command: agent })
        },
        close: () => setConsent((current) => (current?.starting ? current : null)),
      },
    [tour, consent, agents, connecting, offer, start, commands],
  )
}
