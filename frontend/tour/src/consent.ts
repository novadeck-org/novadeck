import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { TourNeedsAgent, type AgentConnection } from "@novadeck/core/port"

// The tour's consent, while it is offered: the agent it would run, whether it is starting,
// and why it couldn't, in the backend's words.
export type TourConsent = {
  readonly agent: AgentName | null
  readonly starting: boolean
  readonly error?: string
  // The agent to start first, where that is why it couldn't (`TourNeedsAgent`).
  readonly needs?: AgentName
  // The agent it was offered on, taken once it can run the tour, as one the welcome connects
  // shows only after the offer.
  readonly preferred?: AgentName
}

// The agents the tour can run, in Novadeck's order of harnesses: those installed and either
// connected or being connected now, as the welcome's choices are once the person takes the tour
// from it. One left connected after its program was removed (its plugin's files outlive it) is
// not among them, as the tour couldn't start it.
export const tourAgents = (connections: readonly AgentConnection[]): readonly AgentName[] =>
  harnesses
    .map(({ id }) => id)
    .filter((id) =>
      connections.some(
        (each) => each.agent === id && each.available && (each.connected || each.busy),
      ),
    )

// Whether the agent is still being connected, so the tour waits to start with it.
export const connectingAgent = (
  connections: readonly AgentConnection[],
  agent: AgentName | null,
): boolean => connections.some((each) => each.agent === agent && each.busy && !each.connected)

// The consent as it opens: on the agent asked for where it can run the tour, else the first
// that can; none where no agent is connected.
export const offerTour = (
  connections: readonly AgentConnection[],
  preferred?: AgentName,
): TourConsent => {
  const agents = tourAgents(connections)
  const agent = preferred !== undefined && agents.includes(preferred) ? preferred : agents[0]
  return { agent: agent ?? null, starting: false, ...(preferred && { preferred }) }
}

// Keeps the consent's agent one that can still run the tour, as connections change while it
// is open; the same consent where nothing it shows changed.
export const followAgents = (
  consent: TourConsent,
  connections: readonly AgentConnection[],
): TourConsent => {
  // Once it starts, the agent it starts with is the one it shows.
  if (consent.starting) return consent
  const agents = tourAgents(connections)
  const { preferred } = consent
  if (preferred !== undefined && agents.includes(preferred))
    return consent.agent === preferred ? consent : { ...consent, agent: preferred }
  if (consent.agent !== null && agents.includes(consent.agent)) return consent
  const agent = agents[0] ?? null
  return agent === consent.agent ? consent : { ...consent, agent }
}

// The person's own pick, which every later change of connections keeps where it can.
export const chooseAgent = (consent: TourConsent, agent: AgentName): TourConsent =>
  consent.starting ? consent : { agent, starting: false, preferred: agent }

export const startingTour = (consent: TourConsent): TourConsent => {
  const { error: _error, needs: _needs, ...rest } = consent
  return { ...rest, starting: true }
}

export const tourFailed = (consent: TourConsent, error: unknown): TourConsent => ({
  ...consent,
  starting: false,
  error: error instanceof Error && error.message ? error.message : "The tour couldn't start.",
  ...(error instanceof TourNeedsAgent && { needs: error.agent }),
})
