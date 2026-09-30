import type { Report } from "../../shell/reports.js"
import type { HarnessEvent } from "../events.js"
import { absolute, sessionId, text } from "../harness.js"

/**
 * Antigravity's hooks, as normalized facts. Every hook names the conversation it runs in,
 * and nothing says how it began: /clear and /resume switch conversations in one process.
 * PreInvocation starts a model call, so the agent works; Stop ends the turn, as failed
 * when it names an error. Its confirmations fire no hook, and an Esc fires nothing: its
 * status line, which NovaDeck's settings hand to the hook as StatusLine, tells both.
 */
export const decode = ({ event, seq, instance, payload }: Report): readonly HarnessEvent[] => {
  if (event === "StatusLine") return statusLine({ seq, instance, payload })
  const id = sessionId(payload.conversationId)
  if (!id) return []
  const workspaces = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []
  const cwd = absolute(workspaces[0])
  const base = { agent: "agy", sessionId: id, instance, startedAt: seq } as const
  const observed: HarnessEvent = {
    type: "session-observed",
    ...base,
    evidence: "conversation-observed",
    ...(cwd !== undefined && { cwd }),
  }
  switch (event) {
    case "PreInvocation":
      return [observed, { type: "turn-started", ...base }]
    case "Stop":
      return [
        observed,
        { type: "turn-ended", ...base, outcome: text(payload.error) ? "failed" : "completed" },
      ]
    default:
      return [observed]
  }
}

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
 * confirmation, whether it plans, how full its context window is, and its named quota windows, each with
 * the fraction left and when it resets. It names the person's account too, which nothing
 * here reads. Before a conversation starts it names none.
 */
const statusLine = ({ seq, instance, payload }: Pick<Report, "seq" | "instance" | "payload">) => {
  const id = sessionId(payload.conversation_id)
  if (!id) return []
  const cwd = absolute(payload.cwd)
  const base = { agent: "agy", sessionId: id, instance, startedAt: seq } as const
  const events: HarnessEvent[] = [
    {
      type: "session-observed",
      ...base,
      evidence: "conversation-observed",
      ...(cwd !== undefined && { cwd }),
    },
    // Its mode, which it names only while not the default, and reruns on when it changes.
    { type: "mode-observed", ...base, planning: payload.cycle_mode === "plan" },
  ]
  // Idle ends the turn however it ended, an Esc or a denial included. Working without a
  // confirmation starts it again, settling any it waited on: a snapshot's hook may start
  // after the next turn's, so neither holds for long against a wrong one.
  if (payload.agent_state === "idle")
    events.push({ type: "turn-ended", ...base, outcome: "completed" })
  else if (payload.tool_confirmation_pending === true)
    events.push({ type: "attention-requested", ...base, ...confirmation, kind: "permission" })
  else if (payload.agent_state === "working" || payload.agent_state === "tool_use")
    events.push({ type: "turn-started", ...base })
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
