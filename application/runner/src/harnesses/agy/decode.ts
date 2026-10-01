import { extname, isAbsolute, relative } from "node:path"

import type { Report } from "../../shell/reports.js"
import type { HarnessEvent, PromptShown } from "../events.js"
import { absolute, sessionId, text } from "../harness.js"

/**
 * Antigravity's hooks, as normalized facts. Every hook names the conversation it runs in,
 * and nothing says how it began: /clear and /resume switch conversations in one process.
 * PreInvocation starts a model call, so the agent works: the turn's first (its
 * `invocationNum` restarts at 0 each turn) as its prompt, any later one as a call of the
 * turn already running. Stop ends the turn, as failed when it names an error, and says
 * whether background work, as a subagent, still runs (`fullyIdle`). Only a completed turn
 * fires Stop: its confirmations fire no hook, and an Esc or a denial fires nothing. Its
 * status line, which NovaDeck's settings hand to the hook as StatusLine, tells both, but
 * reads the same idle after them as after a completed turn: so idle there only ends a
 * turn no Stop ended, and never as completed.
 * Every hook names the conversation's transcript. A plan is an artifact it writes asking
 * for the person's review, which its PostToolUse names.
 */
export const decode = ({ event, seq, instance, payload }: Report): readonly HarnessEvent[] => {
  if (event === "StatusLine") return statusLine({ seq, instance, payload })
  const id = sessionId(payload.conversationId)
  if (!id) return []
  const workspaces = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []
  const cwd = absolute(workspaces[0])
  const transcript = absolute(payload.transcriptPath)
  const base = { agent: "agy", sessionId: id, instance, startedAt: seq } as const
  const observed: HarnessEvent = {
    type: "session-observed",
    ...base,
    evidence: "conversation-observed",
    ...(cwd !== undefined && { cwd }),
    ...(transcript !== undefined && { transcript }),
  }
  switch (event) {
    case "PreInvocation":
      return [
        observed,
        // Its first model call starts a turn, whether the person prompted it or a subagent's
        // message woke the agent: no hook tells which.
        { type: "turn-started", ...base, cause: payload.invocationNum === 0 ? "harness" : "call" },
      ]
    case "Stop":
      return [
        observed,
        {
          type: "turn-ended",
          ...base,
          outcome: text(payload.error) ? "failed" : "completed",
          background: payload.fullyIdle === false,
        },
      ]
    case "PostToolUse":
      return [observed, ...written(base, payload), ...artifact(base, payload)]
    default:
      return [observed]
  }
}

// A plan: Markdown the agent writes, in the conversation's own folder, as an artifact
// asking for the person's review; one it failed to write is none.
const artifact = (
  base: { agent: "agy"; sessionId: string; instance: string | null; startedAt: number },
  payload: Report["payload"],
): HarnessEvent[] => {
  const { name, args } = (payload.toolCall ?? {}) as {
    name?: unknown
    args?: Record<string, unknown>
  }
  const metadata = args?.ArtifactMetadata as { RequestFeedback?: unknown } | undefined
  if (name !== "write_to_file" || metadata?.RequestFeedback !== true || text(payload.error))
    return []
  const path = absolute(args?.TargetFile)
  const folder = absolute(payload.artifactDirectoryPath)
  if (!path || !folder || extname(path) !== ".md") return []
  const inside = relative(folder, path)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return []
  return [{ type: "plan-observed", ...base, actor: null, plan: { kind: "file", path } }]
}

// A file it wrote, as its write_to_file call names it.
const written = (
  base: { agent: "agy"; sessionId: string; instance: string | null; startedAt: number },
  payload: Report["payload"],
): HarnessEvent[] => {
  const { name, args } = (payload.toolCall ?? {}) as {
    name?: unknown
    args?: Record<string, unknown>
  }
  const path = absolute(args?.TargetFile)
  if (name !== "write_to_file" || !path || text(payload.error)) return []
  return [{ type: "file-touched", ...base, actor: null, path }]
}

// Statuses of a subagent that no longer runs.
const finished = new Set(["done", "completed", "finished", "idle", "failed", "cancelled", "error"])

/**
 * Whether the status line lists a subagent still running. It lists them while they run;
 * one that names its state counts only while that is not a finished one.
 */
const subagentsRunning = (subagents: unknown): boolean =>
  Array.isArray(subagents) &&
  subagents.some((subagent) => {
    if (typeof subagent !== "object" || subagent === null) return true
    const { status, state } = subagent as { status?: unknown; state?: unknown }
    const named = text(status) ?? text(state)
    return named === undefined || !finished.has(named.toLowerCase())
  })

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
 * here reads. Before a conversation starts it names none. It says idle only once its own
 * prompt shows: "authenticating" and "initializing" before, behind its login screen and
 * its folder-trust dialog too (probed 2026-10-01, 1.2.14), so a conversation it names
 * while idle is one at its prompt.
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
      root: true,
      ...(payload.agent_state === "idle" && { atPrompt: true }),
    },
    // Its mode, which it names only while not the default, and reruns on when it changes.
    { type: "mode-observed", ...base, planning: payload.cycle_mode === "plan" },
  ]
  // Idle reads the same after a completed turn, an Esc and a denial: it ends a turn its
  // Stop did not, as abnormally. Working without a confirmation starts it again, settling
  // any it waited on, as a call of the turn: a snapshot's hook may start after the next
  // turn's, so neither holds for long against a wrong one.
  if (payload.agent_state === "idle")
    events.push({ type: "turn-idle", ...base, background: subagentsRunning(payload.subagents) })
  else if (payload.tool_confirmation_pending === true)
    events.push({
      type: "attention-requested",
      ...base,
      ...confirmation,
      kind: "permission",
      subject: null,
      choices: [],
    })
  else if (payload.agent_state === "working" || payload.agent_state === "tool_use")
    events.push({ type: "turn-started", ...base, cause: "call" })
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
