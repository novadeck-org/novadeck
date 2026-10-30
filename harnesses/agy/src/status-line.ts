import { absolute, sessionId, text } from "@novadeck/harness-core/decode"
import type { HarnessEvent, PromptShown } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"

import { abandoned, latestOf, type Base } from "./call-memory.js"

// Statuses of a subagent that no longer runs.
const finished = new Set(["done", "completed", "finished", "idle", "failed", "cancelled", "error"])

/**
 * How many subagents the status line lists still running. It lists them while they run,
 * and after, as `completed` (probed 2026-10-04, 1.2.14); one that names its state counts
 * only while that is not a finished one.
 */
const subagentsRunning = (subagents: unknown): number =>
  Array.isArray(subagents)
    ? subagents.filter((subagent) => {
        if (typeof subagent !== "object" || subagent === null) return true
        const { status, state } = subagent as { status?: unknown; state?: unknown }
        const named = text(status) ?? text(state)
        return named === undefined || !finished.has(named.toLowerCase())
      }).length
    : 0

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

// How long each of Antigravity's quota windows lasts, by the end of its name.
const windows = { weekly: 10_080, daily: 1440 } as const

// A confirmation is the one request Antigravity shows at a time, and says nothing of.
const confirmation = {
  requestId: "confirmation",
  actor: null,
  toolName: "confirmation",
} as const

/**
 * Antigravity's status line: whether the agent works or waits on the person's
 * confirmation, whether it plans, how full its context window is, and its named quota
 * windows, each with the fraction left and when it resets. It names the person's account
 * too, which nothing here reads. Before a conversation starts it names none. It says idle
 * only once its own prompt shows: "authenticating" and "initializing" before, behind its
 * login screen and its folder-trust dialog too (probed 2026-10-01, 1.2.14), so a
 * conversation it names while idle is one at its prompt.
 */
export const statusLine = ({
  seq,
  instance,
  payload,
}: Pick<Report, "seq" | "instance" | "payload">): HarnessEvent[] => {
  const id = sessionId(payload.conversation_id)
  if (!id) return []
  const cwd = absolute(payload.cwd)
  const base: Base = { agent: "agy", sessionId: id, instance, startedAt: seq }
  const events: HarnessEvent[] = [
    {
      type: "session-observed",
      ...base,
      evidence: "conversation-observed",
      ...(cwd !== undefined && { cwd }),
      root: true,
      ...(payload.agent_state === "idle" && { atPrompt: true }),
    },
    // Its mode, which it names only while not the default, and reruns on when it changes.
    { type: "mode-observed", ...base, planning: payload.cycle_mode === "plan" },
  ]
  // Idle reads the same after a completed turn, an Esc and a denial: it ends a turn its
  // Stop did not, as abnormally. Working never starts a turn, as its hook may run 10 to
  // 60 ms after the turn's Stop and still say working (probed 2026-10-02, 1.2.14): only
  // PreInvocation starts one. It resumes only a turn an older idle snapshot ended, as an
  // idle one may be stale too, never one a Stop ended. A confirmation it shows counts only
  // while a turn runs (`midTurn`), as Antigravity asks one only mid-turn, before its Stop:
  // one drawn just after the Stop asks nothing. Working without a confirmation settles one
  // the turn waited on. A snapshot's hook may start after the next turn's, so none of
  // these holds for long against a wrong one.
  const working = payload.agent_state === "working" || payload.agent_state === "tool_use"
  // It lists its subagents while the turn runs too, so a working snapshot tells how many
  // run, by status and not position, as the list's order flips (probed 2026-10-07, 1.2.16).
  if (working)
    events.push({ type: "turn-working", ...base, running: subagentsRunning(payload.subagents) })
  const latest = latestOf(id)
  if (payload.agent_state === "idle")
    events.push({
      type: "turn-idle",
      ...base,
      background: { agents: subagentsRunning(payload.subagents), tasks: 0 },
    })
  else if (payload.tool_confirmation_pending === true)
    events.push({
      type: "attention-requested",
      ...base,
      ...confirmation,
      // One request per call it is about, so back-to-back confirmations are distinct.
      ...(latest && { requestId: `confirmation:${latest.id}` }),
      kind: "permission",
      subject: null,
      choices: [],
      // The call its conversation's latest PreToolUse named: the status line names none.
      ...(latest && { input: latest.call }),
      midTurn: true,
    })
  else if (working)
    events.push({
      type: "attention-resolved",
      ...base,
      ...confirmation,
      // Whichever call's, as the status line names none: the actor's oldest.
      loose: true,
      outcome: "allowed",
    })
  // Its count of background tasks, which it drops once none runs. A call that never
  // ended, though no task runs, was denied or stopped, and fires no PostToolUse; with
  // tasks running, so is one that no Stop saw and the count cannot account for.
  if (payload.agent_state === "idle")
    events.push(...abandoned(base, count(payload.task_count) ?? 0))
  const window = (payload.context_window ?? {}) as Record<string, unknown>
  const capacity = count(window.context_window_size)
  const percent = count(window.used_percentage)
  const quota = payload.quota
  const limits =
    typeof quota === "object" && quota !== null
      ? Object.entries(quota as Record<string, unknown>).flatMap(([name, value]) => {
          const { remaining_fraction: left, reset_time: resets } = (value ?? {}) as Record<
            string,
            unknown
          >
          const fraction = count(left)
          if (fraction === undefined) return []
          const at = typeof resets === "string" ? Date.parse(resets) : Number.NaN
          const minutes = Object.entries(windows).find(([end]) => name.endsWith(end))?.[1] ?? null
          return [
            {
              minutes,
              used: Math.max(0, 1 - Math.min(1, fraction)),
              resetsAt: Number.isNaN(at) ? null : at,
            },
          ]
        })
      : undefined
  events.push({
    type: "telemetry-observed",
    ...base,
    // Its share of the window, as it reports it: its token counts come only once a turn
    // is over.
    ...(capacity !== undefined &&
      capacity >= 1 &&
      percent !== undefined && {
        context: {
          occupied: Math.round((capacity * Math.min(100, percent)) / 100),
          capacity: Math.round(capacity),
        },
      }),
    ...(limits !== undefined && { limits: limits.slice(0, 8) }),
  })
  return events
}

/**
 * Antigravity's prompt showing before any conversation: a plain start's status line says
 * idle and names none until the first prompt starts one (probed 2026-10-01, 1.2.14).
 */
export const shown = ({ event, seq, instance, payload }: Report): PromptShown | undefined =>
  event === "StatusLine" && payload.agent_state === "idle" && !payload.conversation_id
    ? { type: "prompt-shown", agent: "agy", instance, startedAt: seq }
    : undefined
