import { agentSessionId, type AgentName } from "@novadeck/protocol"

/** Whether a feature can be used now, and why not when it cannot. */
export type Availability =
  | { readonly state: "ready" }
  | { readonly state: "unavailable"; readonly reason: UnavailableReason }

export type UnavailableReason =
  /** NovaDeck's plugin is not installed into the harness. */
  | "not-connected"
  /** The harness has no such feature. */
  | "unsupported"
  /** The terminal has no reported session of that harness. */
  | "no-session"
  /** The reported session id is not a plain token a shell can run. */
  | "invalid-session"
  /** Another terminal is resuming the session, or holds it in its foreground. */
  | "in-use"

const unavailable = (reason: UnavailableReason): Availability => ({ state: "unavailable", reason })

/** What decides whether a terminal can resume a harness session. */
export type ResumeFacts = {
  readonly agent: AgentName
  readonly resumes: boolean
  readonly connected: boolean
  /** The session the terminal last reported for that harness, if any. */
  readonly session: string | undefined
  /** Whether another terminal claimed the session for a resume, or has it bound. */
  readonly inUse: boolean
}

/**
 * Whether a terminal may resume its harness session. A disconnected harness resumes
 * nothing, whatever it reported before; a session resumes in one terminal at a time.
 */
export const resumeAvailability = (facts: ResumeFacts): Availability => {
  if (!facts.connected) return unavailable("not-connected")
  if (!facts.resumes) return unavailable("unsupported")
  if (facts.session === undefined) return unavailable("no-session")
  if (!agentSessionId.safeParse(facts.session).success) return unavailable("invalid-session")
  if (facts.inUse) return unavailable("in-use")
  return { state: "ready" }
}
