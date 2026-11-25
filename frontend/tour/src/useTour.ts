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
  // Opens the consent and starts Pi's download in the background, so it is usually in place
  // before the person presses Start.
  readonly offer: () => void
  readonly start: () => void
  // Tries Pi's download again, once it failed.
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
  const { tour } = backend
  const fetched = useSyncExternalStore(
    tour?.agent.subscribe ?? never,
    () => tour?.agent.getSnapshot() ?? off,
  )
  // Why the runner refused to download Pi at all (one that can't start it), while it hasn't
  // started one: told as a failed download is, with Try again.
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const agent = useMemo(
    (): TourAgentNote =>
      refused !== undefined && fetched.state === "off"
        ? { step: "failed", text: refused }
        : tourAgentNote(fetched),
    [fetched, refused],
  )
  // As Pi's state changes, an error about starting it is dropped (see `agentChanged`).
  const [seen, setSeen] = useState(agent.step)
  if (seen !== agent.step) {
    setSeen(agent.step)
    setConsent((current) => current && agentChanged(current))
  }
  const fetch = tour?.fetch
  // Asking for the download: a runner that can't start it says why, which the consent shows
  // with Try again.
  const download = useCallback(() => {
    setRefused(undefined)
    fetch?.().catch((error: unknown) =>
      setRefused(
        error instanceof Error && error.message ? error.message : "Pi's download couldn't start.",
      ),
    )
  }, [fetch])
  const offer = useCallback(() => {
    // One already starting stays as it is.
    setConsent((current) => (current?.starting ? current : offerTour()))
    // Asking for the tour is the consent to download Pi: it starts now (one under way or in
    // place changes nothing, and a failed one is tried again).
    download()
  }, [download])
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
        retry: download,
        close: () => setConsent((current) => (current?.starting ? current : null)),
      },
    [tour, consent, agent, offer, start, download],
  )
}
