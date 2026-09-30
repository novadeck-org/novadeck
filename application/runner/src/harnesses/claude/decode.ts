import { basename, dirname, extname } from "node:path"

import type { Report } from "../../shell/reports.js"
import type { HarnessEvent } from "../events.js"
import { absolute, callId, sessionId, sessionStart, subjectOf, text, withMode } from "../harness.js"

/**
 * Claude Code's hooks, as normalized facts.
 *
 * SessionStart names the session running in the terminal, unless it is not the
 * terminal's own: a subagent's (it carries `agent_id`), or Claude Code running inside
 * Cursor. A turn starts with UserPromptSubmit and ends with Stop, or StopFailure on an
 * API error; a subagent's stop ends only its own work. PermissionRequest asks the person
 * about a tool call, AskUserQuestion's as a question and ExitPlanMode's as a plan to
 * review, for the root agent or a subagent;
 * the call's PostToolUse or PostToolUseFailure from that actor means it was allowed. An
 * answered question's call gains its answers, and a plan may be edited in review, so
 * their results match loosely. A denial or
 * an Esc fires nothing: the next turn settles them.
 */
export const decode = (report: Report): readonly HarnessEvent[] =>
  withMode(decodeHook(report), report.payload)

const decodeHook = ({ event, seq, instance, env, payload }: Report): readonly HarnessEvent[] => {
  const id = sessionId(payload.session_id)
  if (!id || payload.cursor_version !== undefined || env.cursor) return []
  const base = { agent: "claude", sessionId: id, instance, startedAt: seq } as const
  const tool = text(payload.tool_name) ?? ""
  const actor = text(payload.agent_id) ?? null
  switch (event) {
    case "SessionStart": {
      if (actor) return []
      const cwd = absolute(payload.cwd)
      const transcript = absolute(payload.transcript_path)
      const evidence = sessionStart(text(payload.source))
      return [
        {
          type: "session-observed",
          ...base,
          evidence,
          ...(cwd !== undefined && { cwd }),
          ...(transcript !== undefined && { transcript }),
        },
      ]
    }
    case "UserPromptSubmit":
      return [{ type: "turn-started", ...base }]
    case "Stop":
      return actor ? [] : [{ type: "turn-ended", ...base, outcome: "completed" }]
    case "StopFailure":
      return actor ? [] : [{ type: "turn-ended", ...base, outcome: "failed" }]
    case "SubagentStart":
      return actor
        ? [
            {
              type: "subagent-started",
              ...base,
              actor,
              actorType: text(payload.agent_type) ?? null,
            },
          ]
        : []
    case "SubagentStop":
      return actor ? [{ type: "subagent-stopped", ...base, actor }] : []
    case "PermissionRequest":
      return [
        {
          type: "attention-requested",
          ...base,
          requestId: callId(actor, tool, payload.tool_input),
          actor,
          toolName: tool,
          ...subjectOf(payload.tool_input),
          kind:
            tool === "AskUserQuestion"
              ? "question"
              : tool === "ExitPlanMode"
                ? "plan"
                : "permission",
        },
        ...presented(base, actor, tool, payload.tool_input),
      ]
    case "PostToolUse":
    case "PostToolUseFailure":
      return [
        {
          type: "attention-resolved",
          ...base,
          requestId: callId(actor, tool, payload.tool_input),
          actor,
          toolName: tool,
          // An answered question's call gains its answers, and a plan may be edited
          // in review.
          loose: tool === "AskUserQuestion" || tool === "ExitPlanMode",
          outcome: "allowed",
        },
        ...drafted(base, actor, tool, payload),
      ]
    case "StatusLine":
      return statusLine(base, payload)
    default:
      return []
  }
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

// Claude Code's rate-limit windows, by their names in its status line.
const windows = { five_hour: 300, seven_day: 10_080 } as const

/**
 * The status line Claude Code runs in NovaDeck's shells hands over what no other source
 * says: the context window's size beside what it holds, and the account's five-hour and
 * seven-day rate limits, used percentage and reset time in epoch seconds.
 */
const statusLine = (
  base: { agent: "claude"; sessionId: string; instance: string | null; startedAt: number },
  payload: Report["payload"],
): HarnessEvent[] => {
  const window = (payload.context_window ?? {}) as Record<string, unknown>
  const usage = (window.current_usage ?? {}) as Record<string, unknown>
  const held = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ]
    .map(count)
    .filter((each): each is number => each !== undefined)
  const capacity = count(window.context_window_size)
  const limits = (payload.rate_limits ?? {}) as Record<string, unknown>
  const known = Object.entries(windows).flatMap(([name, minutes]) => {
    const { used_percentage: used, resets_at: resets } = (limits[name] ?? {}) as Record<
      string,
      unknown
    >
    const percent = count(used)
    if (percent === undefined) return []
    const at = count(resets)
    return [
      { minutes, used: Math.min(1, percent / 100), resetsAt: at !== undefined ? at * 1000 : null },
    ]
  })
  return [
    {
      type: "telemetry-observed",
      ...base,
      ...(held.length > 0 && {
        context: {
          occupied: Math.round(held.reduce((sum, each) => sum + each, 0)),
          capacity: capacity !== undefined && capacity >= 1 ? Math.round(capacity) : null,
        },
      }),
      ...(payload.rate_limits !== undefined && { limits: known }),
    },
  ]
}

// Tools that write a file, and what their input names it by.
const writers = new Set(["Write", "Edit", "MultiEdit"])

/** A Markdown file named by an absolute path. */
const markdown = (value: unknown): string | undefined => {
  const path = absolute(value)
  return path && extname(path) === ".md" ? path : undefined
}

/**
 * A file plan mode drafts a plan in: Markdown in a `plans` folder, as Claude Code keeps
 * them (`~/.claude/plans`, or the config folder's). A plans folder set elsewhere shows
 * when the plan is presented, which names its file whatever the folder.
 */
export const planFile = (value: unknown): string | undefined => {
  const path = markdown(value)
  return path && basename(dirname(path)) === "plans" ? path : undefined
}

// A plan drafted in plan mode: the file its writer wrote.
const drafted = (
  base: { agent: "claude"; sessionId: string; instance: string | null; startedAt: number },
  actor: string | null,
  tool: string,
  payload: Report["payload"],
): HarnessEvent[] => {
  if (!writers.has(tool) || payload.permission_mode !== "plan") return []
  const path = planFile((payload.tool_input as { file_path?: unknown } | undefined)?.file_path)
  return path ? [{ type: "plan-observed", ...base, actor, plan: { kind: "file", path } }] : []
}

// A plan presented for review: its file, or its text when it names none.
const presented = (
  base: { agent: "claude"; sessionId: string; instance: string | null; startedAt: number },
  actor: string | null,
  tool: string,
  input: unknown,
): HarnessEvent[] => {
  if (tool !== "ExitPlanMode") return []
  const { plan, planFilePath } = (input ?? {}) as { plan?: unknown; planFilePath?: unknown }
  // Claude Code names the file itself, replacing whatever the model passed.
  const path = markdown(planFilePath)
  if (path) return [{ type: "plan-observed", ...base, actor, plan: { kind: "file", path } }]
  if (typeof plan !== "string" || !plan) return []
  // Cut short, a character is left whole.
  let end = Math.min(plan.length, maxPlan)
  const last = plan.charCodeAt(end - 1)
  if (end < plan.length && last >= 0xd800 && last <= 0xdbff) end -= 1
  return [
    {
      type: "plan-observed",
      ...base,
      actor,
      plan: { kind: "text", text: plan.slice(0, end), truncated: end < plan.length },
    },
  ]
}

// The longest plan text kept, as the protocol takes it.
export const maxPlan = 256 * 1024
