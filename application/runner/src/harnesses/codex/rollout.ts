import { setTimeout as sleep } from "node:timers/promises"

import type { AgentTelemetry } from "@novadeck/protocol"

import type { HarnessEvent } from "../events.js"
import { followLines } from "../follow.js"
import { bounded, type Harness, type Run } from "../harness.js"
import { transcripts } from "./transcripts.js"

type Limit = AgentTelemetry["limits"][number]

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

// A rate-limit window as Codex reports it: the percentage used, the window's length in
// minutes, and when it resets in epoch seconds.
const limit = (window: unknown): Limit | undefined => {
  if (typeof window !== "object" || window === null) return undefined
  const {
    used_percent: percent,
    window_minutes: minutes,
    resets_at: resets,
  } = window as Record<string, unknown>
  const used = number(percent)
  if (used === undefined) return undefined
  const length = number(minutes)
  const at = number(resets)
  return {
    minutes: length !== undefined && length >= 1 ? Math.round(length) : null,
    used: Math.min(1, Math.max(0, used / 100)),
    resetsAt: at !== undefined ? at * 1000 : null,
  }
}

/**
 * What one line of Codex's rollout says that its hooks do not: its `token_count` events
 * carry the latest response's usage with the model's context window, and the account's
 * rate-limit windows; each turn's `task_started` names its collaboration mode, `plan` in
 * Plan Mode, whose hooks still say `default`; and a Plan item is the plan it proposes.
 */
export const rolloutEvents = (
  line: string,
  { sessionId, instance }: Pick<Run, "sessionId" | "instance">,
): readonly HarnessEvent[] => {
  if (!/"(token_count|task_started|item_completed)"/.test(line)) return []
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return []
  }
  if (typeof record !== "object" || record === null) return []
  const { type, timestamp, payload } = record as Record<string, unknown>
  if (type !== "event_msg" || typeof timestamp !== "string") return []
  const fields = (payload ?? {}) as Record<string, unknown>
  const startedAt = Date.parse(timestamp)
  if (!Number.isFinite(startedAt)) return []
  const base = { agent: "codex", sessionId, instance, startedAt } as const
  switch (fields.type) {
    case "token_count":
      return [telemetry(base, fields)]
    case "task_started":
      return typeof fields.collaboration_mode_kind === "string"
        ? [{ type: "mode-observed", ...base, planning: fields.collaboration_mode_kind === "plan" }]
        : []
    case "item_completed": {
      const { type: kind, text } = (fields.item ?? {}) as { type?: unknown; text?: unknown }
      if (kind !== "Plan" || typeof text !== "string" || !text) return []
      const { text: plan, truncated } = bounded(text)
      return [
        {
          type: "plan-observed",
          ...base,
          actor: null,
          plan: { kind: "text", text: plan, truncated },
        },
      ]
    }
    default:
      return []
  }
}

// A token count's usage and rate-limit windows.
const telemetry = (
  base: { agent: "codex"; sessionId: string; instance: string | null; startedAt: number },
  { info, rate_limits: limits }: Record<string, unknown>,
): HarnessEvent => {
  const usage = (info as { last_token_usage?: { total_tokens?: unknown } } | null)?.last_token_usage
  const occupied = number(usage?.total_tokens)
  const capacity = number((info as { model_context_window?: unknown } | null)?.model_context_window)
  const windows = (limits ?? {}) as { primary?: unknown; secondary?: unknown }
  const known = [limit(windows.primary), limit(windows.secondary)].filter(
    (each): each is Limit => each !== undefined,
  )
  return {
    type: "telemetry-observed",
    ...base,
    ...(occupied !== undefined && {
      context: {
        occupied: Math.max(0, Math.round(occupied)),
        capacity: capacity !== undefined && capacity >= 1 ? Math.round(capacity) : null,
      },
    }),
    ...(limits !== undefined && limits !== null && { limits: known }),
  }
}

/**
 * Follows a bound session's rollout. Codex writes a turn's mode before the hook that
 * binds the session starts, so what the rollout already holds counts too: its latest
 * mode, as of now, and its latest plan and token count, as of when they were written;
 * then each record appended.
 */
export const followRollout: NonNullable<Harness["watch"]> = (run, signal, emit) => {
  // The latest of each kind the backlog held, until it has all been read.
  let backlog: Map<string, HarnessEvent> | undefined = new Map()
  return followLines(
    run.transcript,
    signal,
    (line) => {
      for (const event of rolloutEvents(line, run))
        if (backlog) backlog.set(event.type, event)
        else emit(event)
    },
    {
      fromStart: true,
      onIdle: () => {
        if (!backlog) return
        // The mode holds until the next turn says otherwise, so it holds now, when the
        // binding that would otherwise predate it began; the rest keep their age.
        const now = Date.now()
        for (const event of backlog.values())
          emit(
            event.type === "mode-observed"
              ? { ...event, startedAt: Math.max(event.startedAt, now) }
              : event,
          )
        backlog = undefined
      },
    },
  )
}

/**
 * What one line of a subagent's own rollout says that no hook does: its turn aborted, as
 * Esc on its request does, firing neither `Interrupt` nor `SubagentStop` (probed
 * 2026-10-03, 0.159.3). Its turn over, it waits on the person no longer, though its
 * thread stays open, so it runs on; only an abort from `since` on, when its request was
 * asked, counts.
 */
export const subagentEvents = (
  line: string,
  { sessionId, instance }: Pick<Run, "sessionId" | "instance">,
  actor: string,
  since: number,
): readonly HarnessEvent[] => {
  if (!line.includes('"turn_aborted"')) return []
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return []
  }
  if (typeof record !== "object" || record === null) return []
  const { type, timestamp, payload } = record as Record<string, unknown>
  if (type !== "event_msg" || typeof timestamp !== "string") return []
  if ((payload as { type?: unknown } | null)?.type !== "turn_aborted") return []
  const startedAt = Date.parse(timestamp)
  if (!Number.isFinite(startedAt) || startedAt < since) return []
  return [{ type: "subagent-turn-aborted", agent: "codex", sessionId, instance, actor, startedAt }]
}

// How often a subagent's rollout is looked for until it is found.
const locateMs = 1000

/**
 * Follows a subagent's own rollout, which Codex files beside its root's under its own
 * id (its hooks name only the root's), for its turn aborting from `since` on. Looked for
 * until found, as Codex may write it after the hook that asks.
 */
export const followSubagent: NonNullable<Harness["watchActor"]> = async (
  run,
  actor,
  since,
  signal,
  emit,
) => {
  let path: string | undefined
  while (!signal.aborted) {
    // eslint-disable-next-line no-await-in-loop -- Each look follows the one before.
    path = await transcripts.locate(run.transcript, run.sessionId, actor)
    if (path) break
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(locateMs, undefined, { signal }).catch(() => {})
  }
  if (!path || signal.aborted) return
  await followLines(
    path,
    signal,
    (line) => {
      for (const event of subagentEvents(line, run, actor, since)) emit(event)
    },
    { fromStart: true },
  )
}
