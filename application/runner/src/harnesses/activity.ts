import type { AgentActivity } from "@novadeck/protocol"

import type { Binding } from "./bindings.js"
import type { ActivityEvent } from "./events.js"

/** A request waiting on the person, as its harness identified it. */
type Request = {
  readonly requestId: string
  readonly actor: string | null
  readonly toolName: string
  readonly kind: "permission" | "question" | "plan"
}

/** A subagent running under the bound agent, since its start hook started. */
type Subagent = { readonly id: string; readonly type: string | null; readonly startedAt: number }

// More than any agent runs at once; a runaway harness cannot grow the summary.
const maxSubagents = 32
// How many ended subagents are remembered, so a start arriving after its end is ignored.
// A resumed one keeps its id, and starts after that end.
const maxEnded = 64
// What the protocol carries of an id or a kind.
const maxText = 256

/**
 * What the bound agent is doing, as its hooks said. `turnAt` is when the hook of the
 * latest turn start or end started: a fact from a hook that started before it belongs to
 * a turn already over, however late it arrives. Requests of one turn arrive in any order.
 * Subagents outlive turns, as a background one does, so no turn fences them; `ended`
 * says when each stopped, and `interrupted` spans the latest interrupted turn, whose
 * subagents stopped with it, so a start that arrives late is not taken for a new run.
 * `planning` is what the latest hook to name the agent's mode said, at `planningAt`.
 */
export type Activity = {
  readonly state: "working" | "idle"
  readonly pending: readonly Request[]
  readonly subagents: readonly Subagent[]
  readonly ended: readonly { readonly id: string; readonly at: number }[]
  readonly interrupted: { readonly from: number; readonly to: number } | null
  readonly planning: boolean
  readonly planningAt: number
  readonly turnAt: number
}

/** A freshly bound agent waits for its first prompt. */
export const started = (at: number): Activity => ({
  state: "idle",
  pending: [],
  subagents: [],
  ended: [],
  interrupted: null,
  planning: false,
  planningAt: at,
  turnAt: at,
})

const end = (ended: Activity["ended"], ids: readonly string[], at: number): Activity["ended"] =>
  [...ended.filter(({ id }) => !ids.includes(id)), ...ids.map((id) => ({ id, at }))].slice(
    -maxEnded,
  )

// When the subagent last stopped, if it did.
const endOf = (ended: Activity["ended"], actor: string): number | undefined =>
  ended.find(({ id }) => id === actor)?.at

/** Whether an event belongs to the bound session, from its own process where known. */
export const bound = (
  binding: Binding,
  event: Pick<ActivityEvent, "agent" | "sessionId" | "instance">,
): boolean =>
  binding.agent === event.agent &&
  binding.sessionId === event.sessionId &&
  (binding.instance === null || event.instance === null || binding.instance === event.instance)

/** The index of the request a result resolves: its own call, or loosely the actor's oldest. */
const resolved = (
  pending: readonly Request[],
  event: Extract<ActivityEvent, { type: "attention-resolved" }>,
): number => {
  const exact = pending.findIndex(({ requestId }) => requestId === event.requestId)
  if (exact >= 0 || !event.loose) return exact
  return pending.findIndex(
    ({ actor, toolName }) => actor === event.actor && toolName === event.toolName,
  )
}

/**
 * The activity after an event, or undefined when it changes nothing: another session's,
 * or from a turn already over. A turn's start or end settles every request still
 * waiting, since no harness reports a denial: the person answered it one way or another.
 * An interrupted turn ends the subagents it started, which report no stop then; a
 * background one from an earlier turn runs on.
 */
export const apply = (
  activity: Activity,
  binding: Binding,
  event: ActivityEvent,
): Activity | undefined => {
  if (!bound(binding, event)) return undefined
  switch (event.type) {
    case "mode-observed":
      if (event.startedAt < activity.planningAt) return undefined
      return { ...activity, planning: event.planning, planningAt: event.startedAt }
    case "subagent-started": {
      const { subagents, ended, interrupted } = activity
      const { actor: id, startedAt } = event
      if (
        id.length > maxText ||
        subagents.length >= maxSubagents ||
        subagents.some((subagent) => subagent.id === id) ||
        startedAt < (endOf(ended, id) ?? Number.NEGATIVE_INFINITY) ||
        (interrupted && startedAt >= interrupted.from && startedAt < interrupted.to)
      )
        return undefined
      const type = event.actorType?.slice(0, maxText) ?? null
      return { ...activity, subagents: [...subagents, { id, type, startedAt }] }
    }
    case "subagent-stopped": {
      const { subagents, ended } = activity
      const { actor, startedAt } = event
      const running = subagents.some(({ id }) => id === actor)
      if (actor.length > maxText || (!running && startedAt <= (endOf(ended, actor) ?? -1)))
        return undefined
      // A stop may arrive before its start: remembered, it keeps that start out.
      return {
        ...activity,
        subagents: subagents.filter(({ id }) => id !== actor),
        ended: end(ended, [actor], startedAt),
      }
    }
  }
  if (event.startedAt < activity.turnAt) return undefined
  switch (event.type) {
    case "turn-started":
      return { ...activity, state: "working", pending: [], turnAt: event.startedAt }
    case "turn-ended": {
      const turn = { state: "idle", pending: [], turnAt: event.startedAt } as const
      if (event.outcome !== "interrupted") return { ...activity, ...turn }
      const stopped = activity.subagents.filter(({ startedAt }) => startedAt >= activity.turnAt)
      return {
        ...activity,
        ...turn,
        subagents: activity.subagents.filter((subagent) => !stopped.includes(subagent)),
        ended: end(
          activity.ended,
          stopped.map(({ id }) => id),
          event.startedAt,
        ),
        // A second interrupt of the same turn widens the span rather than replacing it.
        interrupted: {
          from:
            activity.interrupted?.to === activity.turnAt
              ? activity.interrupted.from
              : activity.turnAt,
          to: event.startedAt,
        },
      }
    }
    case "attention-requested": {
      if (activity.pending.some(({ requestId }) => requestId === event.requestId)) return undefined
      const { requestId, actor, toolName, kind } = event
      // An actor shows one plan for review at a time: a revised one replaces it.
      const kept =
        kind === "plan"
          ? activity.pending.filter((each) => each.kind !== "plan" || each.actor !== actor)
          : activity.pending
      return {
        ...activity,
        state: "working",
        pending: [...kept, { requestId, actor, toolName, kind }],
      }
    }
    case "attention-resolved": {
      const index = resolved(activity.pending, event)
      if (index < 0) return undefined
      return { ...activity, pending: activity.pending.toSpliced(index, 1) }
    }
  }
}

/** The activity as clients see it. */
export const summary = ({ state, pending, subagents, planning }: Activity): AgentActivity => ({
  state,
  planning,
  attention: { pending: pending.length, kind: pending[0]?.kind ?? null },
  subagents: subagents.map(({ id, type }) => ({ id, type })),
})
