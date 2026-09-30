import { basename } from "node:path"

import type { AgentDetail } from "@novadeck/protocol"

import { subagentRef, summary, type Activity } from "./activity.js"
import type { Binding } from "./bindings.js"
import type { PlanSource } from "./events.js"
import { ref } from "./harness.js"
import { harnesses } from "./registry.js"
import { telemetrySummary, type Telemetry } from "./telemetry.js"

// More requests than any agent keeps waiting at once, and more actors than it runs.
const maxRequests = 32
const maxActors = 33

/** The reference clients know a session's root agent by. */
export const rootRef = ({ agent, sessionId }: Binding): string => ref("root", agent, sessionId)

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
      plans: [],
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
      .map(({ requestId, actor, toolName, kind, subject, choices, askedAt }) => ({
        ref: ref("request", binding.sessionId, requestId, String(askedAt)),
        actor: actor === null ? root : subagentRef(actor),
        kind,
        tool: toolName.slice(0, 256),
        subject,
        choices: [...choices],
      })),
    plans: (activity?.plans ?? []).map(({ actor, source }) => ({
      ref: planRef(binding, actor, source),
      actor: actor === null ? root : subagentRef(actor),
      source: source.kind,
      name: source.kind === "file" ? basename(source.path).slice(0, 256) : null,
    })),
    coverage: harnesses[binding.agent].coverage,
  }
}

/**
 * The reference clients know a plan by: its actor's, in its file, or presented as text,
 * each presentation its own.
 */
export const planRef = (binding: Binding, actor: string | null, source: PlanSource): string =>
  ref(
    "plan",
    binding.sessionId,
    actor ?? "",
    source.kind === "file" ? source.path : `text\0${ref("text", source.text)}`,
  )

/** The plan a ref names among the bound session's, if it is still an actor's latest. */
export const planOf = (binding: Binding, activity: Activity | null, plan: string) =>
  activity?.plans.find(({ actor, source }) => planRef(binding, actor, source) === plan)

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
