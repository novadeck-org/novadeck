import type { AgentActivity } from "@novadeck/protocol"

import type { Binding } from "./bindings.js"
import type { ActivityEvent } from "./events.js"

/** A request waiting on the person, as its harness identified it. */
type Request = {
  readonly requestId: string
  readonly actor: string | null
  readonly toolName: string
  readonly kind: "permission" | "question"
}

/**
 * What the bound agent is doing, as its hooks said. `turnAt` is when the hook of the
 * latest turn start or end started: a fact from a hook that started before it belongs to
 * a turn already over, however late it arrives. Requests of one turn arrive in any order.
 */
export type Activity = {
  readonly state: "working" | "idle"
  readonly pending: readonly Request[]
  readonly turnAt: number
}

/** A freshly bound agent waits for its first prompt. */
export const started = (at: number): Activity => ({ state: "idle", pending: [], turnAt: at })

/** Whether an event belongs to the bound session, from its own process where known. */
const bound = (binding: Binding, event: ActivityEvent): boolean =>
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
 */
export const apply = (
  activity: Activity,
  binding: Binding,
  event: ActivityEvent,
): Activity | undefined => {
  if (!bound(binding, event) || event.startedAt < activity.turnAt) return undefined
  switch (event.type) {
    case "turn-started":
      return { state: "working", pending: [], turnAt: event.startedAt }
    case "turn-ended":
      return { state: "idle", pending: [], turnAt: event.startedAt }
    case "attention-requested": {
      if (activity.pending.some(({ requestId }) => requestId === event.requestId)) return undefined
      const { requestId, actor, toolName, kind } = event
      return {
        ...activity,
        state: "working",
        pending: [...activity.pending, { requestId, actor, toolName, kind }],
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
export const summary = ({ state, pending }: Activity): AgentActivity => ({
  state,
  attention: { pending: pending.length, kind: pending[0]?.kind ?? null },
})
