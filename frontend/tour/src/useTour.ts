import type { AgentName } from "@novadeck/core/harnesses"
import { useCallback, useMemo, useState, useSyncExternalStore } from "react"

import {
  agentChanged,
  offerTour,
  startingTour,
  tourAgent,
  tourAgentNote,
  tourFailed,
  type TourAgentNote,
  type TourConsent,
} from "./consent"
import { startTour, type TourEffects, type TourStarted } from "./start"
import type { TourHost } from "./tour-host"

const never = (): (() => void) => () => {}
const off = { state: "off" } as const

export type TourOffer = {
  // The consent while it is offered, null otherwise.
  readonly consent: TourConsent | null
  // Where Pi's download stands for the tour: under way, failed, or ready to start.
  readonly agent: TourAgentNote
  // Opens the consent. Pi's download started as Nova was switched on, so it is usually in
  // place before the person presses Start.
  readonly offer: () => void
  readonly start: () => void
  // Tries Pi's download again, once it failed, as switching Nova on again does.
  readonly retry: () => void
  readonly close: () => void
}

/**
 * The tour as the app offers it: the consent, and starting the run once the person agrees.
 * The consent closes once the tour's project and terminal are open; one the backend refused
 * stays open with its reason. Absent (`undefined`) where the backend has no tour (one whose
 * runner is older than the tour on Pi).
 */
export const useTour = (
  { backend, commands }: Pick<TourHost, "backend" | "commands">,
  // A run started, for the tour's driver to follow.
  onStarted: (agent: AgentName, started: TourStarted) => void,
): TourOffer | undefined => {
  const [consent, setConsent] = useState<TourConsent | null>(null)
  const { tour, nova } = backend
  const fetched = useSyncExternalStore(
    tour?.agent.subscribe ?? never,
    () => tour?.agent.getSnapshot() ?? off,
  )
  const agent = useMemo((): TourAgentNote => tourAgentNote(fetched), [fetched])
  // Nova switched off (here, in another window or on another device) takes the tour away: an
  // offer still open closes, as nothing would download for it; a run already starting goes on.
  const novaOn = useSyncExternalStore(
    nova?.enabled.subscribe ?? never,
    () => nova?.enabled.getSnapshot() ?? false,
  )
  if (!novaOn && consent && !consent.starting) setConsent(null)
  // As Pi's state changes, an error about starting it is dropped (see `agentChanged`).
  const [seen, setSeen] = useState(agent.step)
  if (seen !== agent.step) {
    setSeen(agent.step)
    setConsent((current) => current && agentChanged(current))
  }
  // Nova switched on again tries a failed download again; one under way or in place goes on.
  const download = useCallback(() => nova?.set(true), [nova])
  const offer = useCallback(() => {
    // One already starting stays as it is.
    setConsent((current) => (current?.starting ? current : offerTour()))
  }, [])
  const start = useCallback(() => {
    if (!tour || !consent || consent.starting || agent.step !== "ready") return
    setConsent(startingTour(consent))
    const effects: TourEffects = {
      tour,
      openTour: ({ directory, removed }) =>
        commands.openProjectInPlace({ name: "Tour", directory, replaces: removed }),
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
        retry: download,
        close: () => setConsent((current) => (current?.starting ? current : null)),
      },
    [tour, consent, agent, offer, start, download],
  )
}
