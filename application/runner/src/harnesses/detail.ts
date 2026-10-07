import type { AgentDetail, RequestDialog } from "@novadeck/protocol"

import { subagentRef, summary, type Activity, type Request } from "./activity.js"
import type { Binding } from "./bindings.js"
import { ref } from "./harness.js"
import { harnesses } from "./registry.js"
import { telemetrySummary, type Telemetry } from "./telemetry.js"

// More requests than any agent keeps waiting at once, and more actors than it runs.
const maxRequests = 32
const maxActors = 33

/** The reference clients know a session's root agent by. */
export const rootRef = ({ agent, sessionId }: Binding): string => ref("root", agent, sessionId)

/** The reference clients know a request waiting on the person by. */
export const requestRef = ({ sessionId }: Binding, { requestId, askedAt }: Request): string =>
  ref("request", sessionId, requestId, String(askedAt))

/**
 * The agent a terminal runs, in detail: its root and subagents, each request waiting on
 * the person, and what its harness tells. Harnesses do not say which agent started a
 * nested subagent, so a subagent's parent stays unresolved.
 */
export const agentDetail = (
  terminalId: string,
  binding: Binding | null,
  activity: Activity | null,
  telemetry: Telemetry | null,
  dialogs: ReadonlyMap<string, RequestDialog> = new Map(),
  answered: ReadonlySet<string> = new Set(),
): AgentDetail => {
  if (!binding)
    return {
      terminalId,
      agent: null,
      sessionId: null,
      activity: null,
      telemetry: null,
      actors: [],
      requests: [],
      coverage: null,
    }
  const root = rootRef(binding)
  const pending = (activity?.pending ?? []).slice(0, maxRequests)
  const subagents = activity?.subagents ?? []
  // A subagent asking before its start was seen, as one running when the session was
  // bound, is listed too, so every request names a listed actor. Those asking take
  // their places first, so none goes unlisted for want of room; the listed keep their
  // order, oldest first, with those never seen starting last.
  const asking = new Set(
    pending.map(({ actor }) => actor).filter((actor): actor is string => actor !== null),
  )
  const unseen = [...asking]
    .filter((id) => !subagents.some((subagent) => subagent.id === id))
    .map((id) => ({ id, type: null }))
  const quiet = new Set(
    subagents
      .filter(({ id }) => !asking.has(id))
      .slice(0, Math.max(0, maxActors - 1 - asking.size))
      .map(({ id }) => id),
  )
  const children = [...subagents.filter(({ id }) => asking.has(id) || quiet.has(id)), ...unseen]
  const listed = (actor: string) => children.some(({ id }) => id === actor)
  return {
    terminalId,
    agent: binding.agent,
    sessionId: binding.sessionId,
    activity: activity && summary(activity),
    telemetry: telemetry && telemetrySummary(telemetry),
    actors: [
      { ref: root, role: "root", parent: null, type: null },
      ...children.map(({ id, type }) => ({
        ref: subagentRef(id),
        role: "subagent" as const,
        parent: null,
        type,
      })),
    ],
    requests: pending
      .filter(({ actor }) => actor === null || listed(actor))
      .map((request) => {
        const { actor, toolName, kind, subject, choices } = request
        const at = requestRef(binding, request)
        return {
          ref: at,
          actor: actor === null ? root : subagentRef(actor),
          kind,
          tool: toolName.slice(0, 256),
          subject,
          choices: [...choices],
          dialog: dialogs.get(at) ?? null,
          answered: answered.has(at),
        }
      }),
    coverage: harnesses[binding.agent].coverage,
  }
}

/**
 * The native id of the actor a ref names in the bound session: null for its root, a
 * subagent's own id for one running, asking or ended; undefined for any other ref.
 */
export const actorOf = (
  binding: Binding,
  activity: Activity | null,
  actor: string,
): string | null | undefined => {
  if (actor === rootRef(binding)) return null
  const known = [
    ...(activity?.subagents ?? []).map(({ id }) => id),
    ...(activity?.pending ?? []).flatMap(({ actor: id }) => (id === null ? [] : [id])),
    ...(activity?.ended ?? []).map(({ id }) => id),
  ]
  return known.find((id) => subagentRef(id) === actor)
}
