import { setTimeout as sleep } from "node:timers/promises"

import {
  absolute,
  planText,
  errorText,
  callId,
  shortName,
  replied,
} from "@novadeck/harness-core/decode"
import type { HarnessEvent } from "@novadeck/harness-core/events"
import { followLines } from "@novadeck/harness-core/follow"
import type { Harness, Run, WrittenPlan } from "@novadeck/harness-core/harness"
import { record } from "@novadeck/harness-core/items"
import type { Fields } from "@novadeck/harness-core/tools"
import type { AgentTelemetry } from "@novadeck/protocol"

import { callOf, type EventBase } from "./decode.js"
import { mcpTool } from "./tools.js"
import { transcripts } from "./transcripts.js"

// A failed turn's `task_complete` error: its message, and `codex_error_info`, which is
// "usage_limit_exceeded" for a usage limit (a rollout of 2026-10-15, codex 0.16x).
const errored = (error: unknown): { error?: string; limited?: true } => {
  const { message, codex_error_info: info } = (
    typeof error === "object" && error !== null ? error : { message: error }
  ) as { message?: unknown; codex_error_info?: unknown }
  const text = errorText(message)
  return {
    ...(text && { error: text }),
    ...(info === "usage_limit_exceeded" && { limited: true as const }),
  }
}

type Limit = AgentTelemetry["limits"][number]

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

// A rate-limit window as Codex reports it: the percentage used, the window's length in
// minutes, and when it resets in epoch seconds.
const limit = (window: unknown): Limit | undefined => {
  if (typeof window !== "object" || window === null) return undefined
  const { used_percent: percent, window_minutes: minutes, resets_at: resets } = window as Fields
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
 * Plan Mode, whose hooks still say `default`; a Plan item is the plan it proposes; and
 * each turn's end, by the turn's id: `task_complete`, with an `error` where it failed,
 * which fires no hook (0.159.3), or `turn_aborted`. Those end the turn `recorded`, should
 * its hook's report never come. Codex may write a turn's records long after the turn
 * (the failed turns before a session's first good one came together), so only its id
 * says which turn ended. Each turn's `turn_context` names its `model` and reasoning
 * `effort`. An MCP tool call's item completes however its approval went: one the person
 * cancelled fires no hook, and the turn runs on (0.159.3), so its item settles its request.
 */
export const rolloutEvents = (
  line: string,
  { sessionId, instance }: Pick<Run, "sessionId" | "instance">,
): readonly HarnessEvent[] => {
  if (
    !/"(token_count|task_started|item_completed|task_complete|turn_aborted|turn_context)"/.test(
      line,
    )
  )
    return []
  const { type, timestamp, payload } = record(line) ?? {}
  if (typeof timestamp !== "string") return []
  const fields = (payload ?? {}) as Fields
  const startedAt = Date.parse(timestamp)
  if (!Number.isFinite(startedAt)) return []
  const base: EventBase = { agent: "codex", sessionId, instance, startedAt }
  if (type === "turn_context") {
    const { model, effort } = fields
    // A turn that names its model names its effort too, none clearing the last model's.
    const level = shortName(effort, 32) ?? null
    const name = shortName(model, 128)
    const named = {
      ...(name && { model: name, effort: level }),
      ...(level !== null && { effort: level }),
    }
    return Object.keys(named).length > 0 ? [{ type: "telemetry-observed", ...base, ...named }] : []
  }
  if (type !== "event_msg") return []
  switch (fields.type) {
    case "token_count":
      return [telemetry(base, fields)]
    case "task_started":
      return typeof fields.collaboration_mode_kind === "string"
        ? [{ type: "mode-observed", ...base, planning: fields.collaboration_mode_kind === "plan" }]
        : []
    case "task_complete":
    case "turn_aborted": {
      const turn = typeof fields.turn_id === "string" ? fields.turn_id : undefined
      const failed =
        fields.type === "task_complete" && fields.error !== undefined && fields.error !== null
      const outcome =
        fields.type === "turn_aborted" ? "interrupted" : failed ? "failed" : "completed"
      return [
        {
          type: "turn-ended",
          ...base,
          outcome,
          recorded: true,
          ...(turn && { turn }),
          ...replied(fields.last_agent_message),
          ...(failed && errored(fields.error)),
        },
      ]
    }
    case "item_completed": {
      const {
        type: kind,
        text,
        status,
        changes,
      } = (fields.item ?? {}) as {
        type?: unknown
        text?: unknown
        status?: unknown
        changes?: unknown
      }
      if (kind === "McpToolCall") return mcpSettled(base, fields.item as Fields)
      // Files a patch changed, by absolute path, however it ran: its PostToolUse comes for
      // the apply_patch tool alone, and none for a patch the model ran through its shell
      // (`apply_patch <<EOF`; probed 2026-10-15, 0.159.3, which the fake model does).
      if (kind === "FileChange")
        return status === "completed" && typeof changes === "object" && changes !== null
          ? Object.keys(changes).flatMap((file) => {
              const path = absolute(file)
              return path
                ? [
                    {
                      type: "file-touched" as const,
                      ...base,
                      actor: null,
                      path,
                      settles: true as const,
                    },
                  ]
                : []
            })
          : []
      if (kind !== "Plan" || typeof text !== "string" || !text) return []
      const { text: plan, truncated } = planText(text)
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

// The request an MCP tool call's completed item settles, by the tool its hooks name.
const mcpSettled = (
  base: EventBase,
  { server, tool, arguments: input }: Fields,
): HarnessEvent[] => {
  if (typeof server !== "string" || !server || typeof tool !== "string" || !tool) return []
  const toolName = mcpTool(server, tool)
  return [
    {
      type: "attention-resolved",
      ...base,
      requestId: callId(null, toolName, callOf(input)),
      actor: null,
      toolName,
      loose: false,
      outcome: "settled",
    },
  ]
}

/** The plan a rollout line proposes, as `rolloutEvents` reads it. */
export const rolloutPlans = (line: string): readonly WrittenPlan[] =>
  rolloutEvents(line, { sessionId: "", instance: null }).flatMap((event) =>
    event.type === "plan-observed" ? [{ source: event.plan, at: event.startedAt }] : [],
  )

// A token count's usage and rate-limit windows.
const telemetry = (base: EventBase, { info, rate_limits: limits }: Fields): HarnessEvent => {
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
  // The latest of each kind the backlog held, until it has all been read. A turn's model
  // is a kind of its own, apart from the token counts.
  let backlog: Map<string, HarnessEvent> | undefined = new Map()
  return followLines(
    run.transcript,
    signal,
    (line) => {
      for (const event of rolloutEvents(line, run))
        if (backlog)
          backlog.set(
            event.type === "telemetry-observed" && (event.model !== undefined || event.effort)
              ? "model"
              : event.type,
            event,
          )
        else emit(event)
    },
    {
      fromStart: true,
      onIdle: () => {
        if (!backlog) return
        // The mode holds until the next turn says otherwise, so it holds now, when the
        // binding that would otherwise predate it began; the rest keep their age.
        // Oldest first, as telemetry older than the last it took is turned away.
        const now = Date.now()
        const held = [...backlog.values()].map((event) =>
          event.type === "mode-observed"
            ? { ...event, startedAt: Math.max(event.startedAt, now) }
            : event,
        )
        for (const event of held.toSorted((a, b) => a.startedAt - b.startedAt)) emit(event)
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
  const { type, timestamp, payload } = record(line) ?? {}
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
