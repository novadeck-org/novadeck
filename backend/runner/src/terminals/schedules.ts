import { isFields } from "@novadeck/harness-core/fields"
import type { Report } from "@novadeck/harness-core/report"
import type { AgentName } from "@novadeck/protocol"

import type { Record } from "./record.js"

/**
 * What an agent scheduled that lives only in its process, and so dies if it is stopped: a
 * Claude Code cron (`CronCreate`, session-only unless `durable`) and an Antigravity
 * `schedule` that repeats (a cron) or is set out longer than its wake-ups are tracked
 * (`pending` in its call-memory.ts). Codex has no such tool (its tool list holds no
 * scheduler, probed 2026-11). Its ScheduleWakeup and shorter timers are the activity's `wake`.
 */
export type Schedule = {
  readonly key: string
  /** When it ends by itself, epoch milliseconds; null while it repeats. */
  readonly until: number | null
}

/** A change to what the agent has scheduled, as one report tells it. */
export type ScheduleChange =
  | { readonly add: Schedule; readonly agent: AgentName; readonly sessionId: string }
  | { readonly remove: string; readonly agent: AgentName; readonly sessionId: string }

/** The longest timer Antigravity's wake-up tracking follows, in seconds. */
const trackedSeconds = 86_400

const string = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value.slice(0, 256) : undefined

/** What the report says of the agent's schedules, if anything. */
export const scheduleChange = (report: Report): ScheduleChange | undefined => {
  const { payload } = report
  if (report.agent === "claude") {
    const sessionId = string(payload.session_id)
    const tool = payload.tool_name
    if (!sessionId || report.event !== "PostToolUse") return undefined
    const input = isFields(payload.tool_input) ? payload.tool_input : {}
    // Probed 2026-11-07 (2.1.316, e2e/probes/cron-id.e2e.ts): the create's `tool_response` is
    // `{ id, recurring, durable, nextFireAt }` and the delete's `tool_input` is `{ id }`.
    if (tool === "CronCreate") {
      const response = isFields(payload.tool_response) ? payload.tool_response : {}
      // Kept on disk and restored by a resume: nothing to lose.
      if (response.durable === true || input.durable === true) return undefined
      // An id it cannot read (a release renamed it) is a cron no delete can match: it
      // stands for the session, so the agent stays awake rather than lose it.
      const key = string(response.id) ?? `unread:${report.seq}`
      // A one-shot reminder is gone once it has fired.
      const at = response.recurring === false ? response.nextFireAt : undefined
      const until = typeof at === "number" ? Math.ceil(at) : null
      return { add: { key, until }, agent: "claude", sessionId }
    }
    if (tool === "CronDelete") {
      const key = string(input.id)
      return key ? { remove: key, agent: "claude", sessionId } : undefined
    }
    return undefined
  }
  if (report.agent === "agy" && report.event === "PreToolUse") {
    const sessionId = string(payload.conversationId)
    const call = payload.toolCall
    if (!sessionId || !isFields(call) || call.name !== "schedule" || !isFields(call.args))
      return undefined
    const { args } = call
    const seconds = args.DurationSeconds
    const cron = "CronExpression" in args
    const long = typeof seconds === "number" && seconds > trackedSeconds
    if (!cron && !long) return undefined
    const key = `${sessionId}:${String(payload.stepIdx ?? report.seq)}`
    const until = cron ? null : report.seq + (seconds as number) * 1000
    return { add: { key, until }, agent: "agy", sessionId }
  }
  return undefined
}

/** Applies a change to the record's schedules; whatever another session held is dropped. */
export const trackSchedules = (record: Pick<Record, "schedules">, change: ScheduleChange): void => {
  const same = record.schedules?.sessionId === change.sessionId
  const items = new Map(same ? record.schedules!.items : [])
  if ("add" in change) items.set(change.add.key, change.add)
  else items.delete(change.remove)
  record.schedules = { sessionId: change.sessionId, items }
}

/** Whether the bound session has a schedule standing at `now`: one that would die with it. */
export const scheduled = (
  record: Pick<Record, "schedules">,
  sessionId: string | undefined,
  now: number,
): boolean => {
  const { schedules } = record
  if (!schedules || schedules.sessionId !== sessionId) return false
  for (const { until } of schedules.items.values()) if (until === null || until > now) return true
  return false
}
