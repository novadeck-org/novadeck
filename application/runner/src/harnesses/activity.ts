import type { AgentActivity } from "@novadeck/protocol"

import type { Binding } from "./bindings.js"
import type { ActivityEvent, Background, PlanSource } from "./events.js"
import { ref } from "./harness.js"

/** The reference clients know a subagent by. */
export const subagentRef = (id: string): string => ref("subagent", id)

/** A request waiting on the person, as its harness identified it. */
type Request = {
  readonly requestId: string
  readonly actor: string | null
  readonly toolName: string
  readonly kind: "permission" | "question" | "plan"
  readonly subject: string | null
  readonly choices: readonly string[]
  /** When its hook started: asked again later, the same call is another request. */
  readonly askedAt: number
}

/** An actor's latest plan, as the hook that named it started. */
type Plan = { readonly actor: string | null; readonly source: PlanSource; readonly at: number }

// One plan per actor, and no more actors than an agent runs.
const maxPlans = 33

/**
 * A subagent running under the bound agent, since its start hook started. `abortedAt` is
 * when its turn aborted, its requests settled, where it hasn't asked since: Codex keeps its
 * thread open, so it may never run again.
 */
type Subagent = {
  readonly id: string
  readonly type: string | null
  readonly startedAt: number
  readonly abortedAt?: number
}

// More than any agent runs at once; a runaway harness cannot grow the summary. Once full,
// the subagent whose turn aborted longest ago, idle since, makes room for another.
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
 * `idled` says an idle status line, not a Stop, ended the latest turn, at `turnAt`.
 * `background` is what the latest turn's end left running that wakes the agent once
 * done: the agent works on while subagents of it run (see `summary`). `continued` says
 * Novadeck continued the turn at its latest Stop, at `turnAt`, and `skips` counts the
 * records of such Stops yet to come that name no turn: Claude Code records a Stop it
 * continued, once its hook answered, as it does any other, and that record ends nothing.
 * `lastTurn` says how the latest turn to end ended, the start of the agent's last reply
 * in it, and when it ended; a turn's start clears it, and a continued Stop keeps it,
 * should the continuation lapse.
 */
export type Activity = {
  readonly state: "working" | "idle"
  readonly pending: readonly Request[]
  readonly subagents: readonly Subagent[]
  readonly ended: readonly { readonly id: string; readonly at: number }[]
  readonly interrupted: { readonly from: number; readonly to: number } | null
  readonly planning: boolean
  readonly planningAt: number
  /** Each actor's latest plan, in the order the actors first planned. */
  readonly plans: readonly Plan[]
  readonly turnAt: number
  readonly idled: boolean
  readonly background: Background | null
  /**
   * Whether work a turn leaves running wakes the agent once done, as Claude Code's and
   * Antigravity's does and Codex's never does: where nothing says what runs, its
   * subagents still running count.
   */
  readonly wakes: boolean
  /** The latest turn's id, where its harness names one. */
  readonly turn: string | null
  readonly continued: boolean
  readonly skips: number
  /**
   * Whether an idle status line has counted the subagents among what the latest turn's
   * end left running since: until then, work its Stop said only exists may be one.
   */
  readonly listed: boolean
  readonly lastTurn: LastTurn | null
}

/**
 * How a turn ended, the start of the agent's last reply in it where told, and `at`, when
 * that end was reported, which tells it from any other. `recorded` says only the
 * session's records told it, whose hook may yet come and say more of the same end.
 */
export type LastTurn = {
  readonly outcome: "completed" | "failed" | "interrupted" | "unknown"
  readonly reply: string | null
  readonly at: number
  readonly recorded: boolean
}

/** A freshly bound agent waits for its first prompt. */
export const started = (at: number, wakes = true): Activity => ({
  state: "idle",
  pending: [],
  subagents: [],
  ended: [],
  interrupted: null,
  planning: false,
  planningAt: at,
  plans: [],
  turnAt: at,
  idled: false,
  background: null,
  wakes,
  turn: null,
  continued: false,
  skips: 0,
  listed: false,
  lastTurn: null,
})

/**
 * What a turn's end leaves the agent waiting on: what its harness `said`, else the
 * subagents still running where their end wakes it; null for nothing.
 */
const waiting = (
  { wakes }: Activity,
  subagents: readonly Subagent[],
  said?: Background,
): Background | null => {
  return counted(said ?? { agents: wakes ? subagents.length : 0, tasks: 0 })
}

/** Work left running, or null for none: nothing counted, and no more said to run. */
const counted = (background: Background): Background | null =>
  background.agents + background.tasks > 0 || background.more ? background : null

const end = (ended: Activity["ended"], ids: readonly string[], at: number): Activity["ended"] =>
  [...ended.filter(({ id }) => !ids.includes(id)), ...ids.map((id) => ({ id, at }))].slice(
    -maxEnded,
  )

// When the subagent last stopped, if it did.
const endOf = (ended: Activity["ended"], actor: string): number | undefined =>
  ended.find(({ id }) => id === actor)?.at

/**
 * The subagents with room for one more: full, less the one whose turn aborted longest ago
 * with no request since (it asks again as one never seen starting); undefined when none
 * can give way.
 */
const room = (subagents: readonly Subagent[]): readonly Subagent[] | undefined => {
  if (subagents.length < maxSubagents) return subagents
  let oldest: number | undefined
  for (const [index, { abortedAt }] of subagents.entries())
    if (
      abortedAt !== undefined &&
      (oldest === undefined || abortedAt < subagents[oldest]!.abortedAt!)
    )
      oldest = index
  return oldest === undefined ? undefined : subagents.toSpliced(oldest, 1)
}

/**
 * Whether a subagent may start running at `startedAt`: not running already, room for it,
 * and no later stop of it, nor the interrupted turn that ended it, says it is over.
 */
const startable = (
  { subagents, ended, interrupted }: Activity,
  id: string,
  startedAt: number,
): boolean =>
  id.length <= maxText &&
  room(subagents) !== undefined &&
  !subagents.some((subagent) => subagent.id === id) &&
  startedAt >= (endOf(ended, id) ?? Number.NEGATIVE_INFINITY) &&
  !(interrupted && startedAt >= interrupted.from && startedAt < interrupted.to)

/** Whether an event belongs to the bound session, from its own process where known. */
export const bound = (
  binding: Binding,
  event: Pick<ActivityEvent, "agent" | "sessionId" | "instance">,
): boolean =>
  binding.agent === event.agent &&
  binding.sessionId === event.sessionId &&
  (binding.instance === null || event.instance === null || binding.instance === event.instance)

/**
 * The index of the request a result resolves: its own call, or loosely the actor's oldest.
 * A result's hook starts after its request's, so one that started before resolves an
 * earlier ask of the same call, never this one.
 */
const resolved = (
  pending: readonly Request[],
  event: Extract<ActivityEvent, { type: "attention-resolved" }>,
): number => {
  const asked = (request: Request) => event.startedAt >= request.askedAt
  const exact = pending.findIndex(
    (request) => request.requestId === event.requestId && asked(request),
  )
  if (exact >= 0 || !event.loose) return exact
  return pending.findIndex(
    (request) =>
      request.actor === event.actor && request.toolName === event.toolName && asked(request),
  )
}

/**
 * The requests a root turn's start or end leaves waiting: a running subagent's, as a
 * background one's outlives the turn. The root's own, and those of a subagent no longer
 * running, are settled.
 */
const outliving = (
  pending: readonly Request[],
  subagents: readonly Subagent[],
): readonly Request[] =>
  pending.filter(({ actor }) => actor !== null && subagents.some(({ id }) => id === actor))

/**
 * The activity after an event, or undefined when it changes nothing: another session's,
 * or from a turn already over. A root turn's start or end settles the root's own requests
 * still waiting: no harness ends a root turn normally while its own dialog waits, a
 * denial ends it abnormally, and one answered with no report, as another hook's denial,
 * would otherwise wait forever. A running subagent's requests answer to no root turn: each
 * waits for its own resolution, its turn's abort or its stop. An interrupted turn ends the
 * subagents it started, which report no stop then; a background one from an earlier turn
 * runs on.
 */
export const apply = (
  activity: Activity,
  binding: Binding,
  event: ActivityEvent,
): Activity | undefined => {
  if (!bound(binding, event)) return undefined
  switch (event.type) {
    case "plan-observed": {
      const { actor, plan: source, startedAt: at } = event
      const index = activity.plans.findIndex((plan) => plan.actor === actor)
      const next = { actor, source, at }
      // An actor's plan keeps its place.
      if (index >= 0)
        return activity.plans[index]!.at > at
          ? undefined
          : { ...activity, plans: activity.plans.toSpliced(index, 1, next) }
      // Full, the oldest subagent's plan makes room.
      const evicted =
        activity.plans.length < maxPlans
          ? -1
          : activity.plans.reduce(
              (oldest, plan, position, plans) =>
                plan.actor !== null && (oldest < 0 || plan.at < plans[oldest]!.at)
                  ? position
                  : oldest,
              -1,
            )
      if (activity.plans.length >= maxPlans && evicted < 0) return undefined
      const kept = evicted < 0 ? activity.plans : activity.plans.toSpliced(evicted, 1)
      return { ...activity, plans: [...kept, next] }
    }
    case "file-touched":
      return undefined
    case "mode-observed":
      if (event.startedAt < activity.planningAt) return undefined
      return { ...activity, planning: event.planning, planningAt: event.startedAt }
    case "subagent-started": {
      const { actor: id, startedAt } = event
      if (!startable(activity, id, startedAt)) return undefined
      const type = event.actorType?.slice(0, maxText) ?? null
      return { ...activity, subagents: [...room(activity.subagents)!, { id, type, startedAt }] }
    }
    case "subagent-stopped": {
      const { subagents, ended } = activity
      const { actor, startedAt } = event
      const running = subagents.some(({ id }) => id === actor)
      if (actor.length > maxText || (!running && startedAt <= (endOf(ended, actor) ?? -1)))
        return undefined
      // A stop may arrive before its start: remembered, it keeps that start out. A
      // stopped subagent waits on the person no longer, whatever it asked.
      return {
        ...activity,
        pending: activity.pending.filter(
          (request) => request.actor !== actor || request.askedAt > startedAt,
        ),
        // A resumed run that started after this stop runs on.
        subagents: subagents.filter((each) => each.id !== actor || each.startedAt > startedAt),
        ended: end(ended, [actor], startedAt),
      }
    }
    case "subagent-turn-aborted": {
      // Its dialogs closed with the turn; its thread, and so the subagent, runs on, idle
      // until it asks again, unless it already did.
      const { actor, startedAt } = event
      const pending = activity.pending.filter(
        (request) => request.actor !== actor || request.askedAt > startedAt,
      )
      if (pending.length === activity.pending.length) return undefined
      const idle = !pending.some((request) => request.actor === actor)
      const subagents = activity.subagents.map((each) =>
        idle && each.id === actor ? { ...each, abortedAt: startedAt } : each,
      )
      return { ...activity, pending, subagents }
    }
    case "attention-resolved": {
      const index = resolved(activity.pending, event)
      // A subagent's request outlives the root's turn, and so does its result; the root's
      // own results answer to its turns.
      if (
        index < 0 ||
        (event.startedAt < activity.turnAt && activity.pending[index]!.actor === null)
      )
        return undefined
      return { ...activity, pending: activity.pending.toSpliced(index, 1) }
    }
    case "attention-requested": {
      // A subagent's request answers to no root turn, as its result doesn't. One not seen
      // running, as its start came before the binding or its harness reported its stop at
      // a turn's end (Codex), runs from its request on, unless it is known to be over.
      const { actor, startedAt } = event
      if (actor === null) break
      if (activity.subagents.some(({ id }) => id === actor)) return asked(activity, event)
      if (startable(activity, actor, startedAt)) {
        const next = asked(activity, event)
        const subagent = { id: actor, type: null, startedAt }
        return next && { ...next, subagents: [...room(next.subagents)!, subagent] }
      }
    }
  }
  // The record of a Stop Novadeck continued uses up its skip whenever it is read, even
  // once a later Stop has moved the fence past it, so no skip is left to eat a later end.
  if (event.type === "turn-ended" && event.recorded && !event.turn && activity.skips > 0)
    return { ...activity, skips: activity.skips - 1 }
  if (event.startedAt < activity.turnAt) return undefined
  switch (event.type) {
    case "turn-started":
      return {
        ...activity,
        state: "working",
        pending: outliving(activity.pending, activity.subagents),
        turnAt: event.startedAt,
        idled: false,
        background: null,
        turn: event.turn ?? null,
        continued: false,
        skips: 0,
        lastTurn: null,
      }
    case "turn-continued":
      // Only the Stop that just ended the turn; never one after a later fact. What it said
      // runs stays, should the continuation lapse.
      if (activity.state !== "idle" || event.startedAt !== activity.turnAt) return undefined
      return { ...activity, state: "working", continued: true, skips: activity.skips + 1 }
    case "turn-lapsed":
      // The continuation never came: the turn ended at its Stop after all.
      if (activity.state !== "working" || !activity.continued) return undefined
      return {
        ...activity,
        state: "idle",
        pending: outliving(activity.pending, activity.subagents),
        continued: false,
      }
    case "turn-idle": {
      // Idle after the turn's Stop says nothing new of the turn; without one, the turn
      // ended abnormally. Newer than the Stop, it counts the subagents still running of
      // what that Stop left; what else that Stop said runs, as a command (Antigravity's),
      // which it never lists, stays.
      if (activity.state !== "working") {
        const { background } = activity
        const { agents } = event.background
        if (
          !background ||
          event.startedAt <= activity.turnAt ||
          (activity.listed && background.agents === agents)
        )
          return undefined
        return { ...activity, background: counted({ ...background, agents }), listed: true }
      }
      return {
        ...activity,
        state: "idle",
        pending: outliving(activity.pending, activity.subagents),
        turnAt: event.startedAt,
        idled: true,
        background: waiting(activity, activity.subagents, event.background),
        listed: true,
        // An Escape or a refusal, which only an idle status line tells.
        lastTurn: { outcome: "unknown", reply: null, at: event.startedAt, recorded: false },
      }
    }
    case "turn-escaped":
      // The turn may be over, as delivery takes it: idle, its requests settled, until a
      // later hook moves it on. No working status line resumes it.
      if (activity.state !== "working") return undefined
      return {
        ...activity,
        state: "idle",
        pending: outliving(activity.pending, activity.subagents),
        turnAt: event.startedAt,
        idled: false,
        background: waiting(activity, activity.subagents),
        lastTurn: { outcome: "interrupted", reply: null, at: event.startedAt, recorded: false },
      }
    case "turn-working":
      // Working after the idle that ended its turn, and newer than it: that idle was stale,
      // and the turn goes on. After a Stop it says nothing new. The turn's fence stays at the
      // idle, so a Stop whose hook started before this snapshot still ends it.
      if (activity.state !== "idle" || !activity.idled || event.startedAt <= activity.turnAt)
        return undefined
      return { ...activity, state: "working", idled: false }
    case "turn-ended": {
      // Its records end only the turn still running, its own where they name one, and
      // leave its fence where it was, so the hook's own Stop, should it come after all,
      // still says what the turn left. One naming no turn may be of a Stop Novadeck
      // continued, whose continuation runs on: it is used up instead.
      const { recorded, turn: named } = event
      if (
        recorded &&
        (activity.state !== "working" || (named && activity.turn && named !== activity.turn))
      )
        return undefined
      const turn = {
        state: "idle",
        turnAt: recorded ? activity.turnAt : event.startedAt,
        idled: false,
        continued: false,
        listed: false,
        lastTurn: {
          outcome: event.outcome,
          reply: event.reply ?? null,
          // The hook's own Stop after its records ended the turn says more of that end.
          at:
            activity.state === "idle" && activity.lastTurn?.recorded && !recorded
              ? activity.lastTurn.at
              : event.startedAt,
          recorded: recorded === true,
        },
      } as const
      if (event.outcome !== "interrupted")
        return {
          ...activity,
          ...turn,
          pending: outliving(activity.pending, activity.subagents),
          background: waiting(activity, activity.subagents, event.background),
        }
      const stopped = activity.subagents.filter(({ startedAt }) => startedAt >= activity.turnAt)
      const subagents = activity.subagents.filter((subagent) => !stopped.includes(subagent))
      return {
        ...activity,
        ...turn,
        background: waiting(activity, subagents, event.background),
        // The subagents it ended wait on the person no longer.
        pending: outliving(activity.pending, subagents),
        subagents,
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
    case "attention-requested":
      return asked(activity, event)
  }
}

/**
 * The activity once a request is asked, or undefined when it asks nothing new. Requests
 * arrive in any order, and a subagent's parallel calls may show several dialogs at once,
 * so none settles another: a subagent's waits for its own result, its turn's abort or its
 * stop, as one answered with no report must (a denial); the root's, for the turn's end.
 */
const asked = (
  activity: Activity,
  event: Extract<ActivityEvent, { type: "attention-requested" }>,
): Activity | undefined => {
  if (activity.pending.some(({ requestId }) => requestId === event.requestId)) return undefined
  // One only a turn asks, shown while none runs, is a stale snapshot of the turn a Stop
  // ended: a turn running, or one a working resumed, is the only one it can be.
  if (event.midTurn === true && activity.state !== "working") return undefined
  const { requestId, actor, toolName, kind, subject, choices, startedAt } = event
  // Asked by a subagent before it stopped, it waits on the person no longer.
  const stopped = actor === null ? undefined : endOf(activity.ended, actor)
  if (stopped !== undefined && startedAt < stopped) return undefined
  // An actor shows one plan for review at a time: a revised one replaces it.
  const kept = activity.pending.filter(
    (each) => kind !== "plan" || each.kind !== "plan" || each.actor !== actor,
  )
  return {
    ...activity,
    // The root asks only while its turn runs; a subagent's request, as a background one
    // asks after the root's Stop, neither starts nor resumes the root's turn. A subagent
    // asking after its turn aborted runs again.
    ...(actor === null && { state: "working" }),
    subagents: activity.subagents.map((each) =>
      each.id === actor && each.abortedAt !== undefined && startedAt >= each.abortedAt
        ? { id: each.id, type: each.type, startedAt: each.startedAt }
        : each,
    ),
    pending: [...kept, { requestId, actor, toolName, kind, subject, choices, askedAt: startedAt }],
  }
}

/**
 * The activity as clients see it: working while its turn runs, and after it while
 * subagents it left running, which wake it once done, run on: work its Stop says only
 * exists counts as one until a status line has counted them. Other work it left running,
 * as a command, shows in `background`, but never keeps it working: a dev server may run
 * for ever. How its latest turn ended shows once none runs, a continued one included.
 */
export const summary = ({
  state,
  pending,
  subagents,
  planning,
  background,
  listed,
  lastTurn,
}: Activity): AgentActivity => ({
  state:
    state === "working" ||
    (background !== null && (background.agents > 0 || (background.more === true && !listed)))
      ? "working"
      : "idle",
  background:
    state === "working" || !background
      ? null
      : { agents: background.agents, tasks: background.tasks },
  planning,
  attention: { pending: pending.length, kind: pending[0]?.kind ?? null },
  subagents: subagents.map(({ id, type }) => ({ id: subagentRef(id), type })),
  lastTurn:
    state === "working" || !lastTurn
      ? null
      : { outcome: lastTurn.outcome, reply: lastTurn.reply, at: lastTurn.at },
})
