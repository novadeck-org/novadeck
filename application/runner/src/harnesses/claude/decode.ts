import { basename, dirname, extname } from "node:path"

import type { Report } from "../../shell/reports.js"
import type { Background, HarnessEvent } from "../events.js"
import {
  absolute,
  withRequestCwd,
  bounded,
  callId,
  promptStart,
  replied,
  sessionId,
  sessionStart,
  subjectOf,
  text,
  withMode,
  type WrittenPlan,
  shortName,
} from "../harness.js"
import { at as writtenAt, record } from "../items.js"

/**
 * Claude Code's hooks, as normalized facts.
 *
 * SessionStart names the session running in the terminal, unless it is not the
 * terminal's own: a subagent's (it carries `agent_id`), or Claude Code running inside
 * Cursor. A turn starts with UserPromptSubmit, which Claude Code also sends with a task
 * notification as it starts a turn by itself, and ends with Stop, which lists background
 * tasks still running, or StopFailure on an API error; a subagent's stop ends only its
 * own work. PermissionRequest asks the person
 * about a tool call, AskUserQuestion's as a question and ExitPlanMode's as a plan to
 * review, for the root agent or a subagent;
 * the call's PostToolUse or PostToolUseFailure from that actor means it was allowed. An
 * answered question's call gains its answers, and a plan may be edited in review, so
 * their results match loosely. A denial or
 * an Esc fires nothing: the next turn settles them.
 */
export const decode = (report: Report): readonly HarnessEvent[] =>
  withRequestCwd(withMode(decodeHook(report), report.payload), report.payload)

/** The tool name an elicitation of `server` goes by: it is no tool call, so it takes this. */
export const elicitationTool = (server: string): string => `mcp__${server}__elicitation`

/**
 * The SessionStart sources that announce a session at Claude Code's own input prompt.
 * Probed on 2026-10-01 (2.1.287): SessionStart never fired while its trust dialog or
 * first-run onboarding showed, nor while `--resume` without an id showed its session
 * picker; at a `startup`, a `clear`, a `resume` (as the runner restores a terminal with
 * `claude --resume <id>`, and as `--continue` does) or a `fork` (`--fork-session`) it
 * fired within about 150 ms of its empty prompt drawing.
 */
const atPrompt: ReadonlySet<string> = new Set(["startup", "clear", "resume", "fork"])

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
      const source = text(payload.source)
      const evidence = sessionStart(source)
      return [
        {
          type: "session-observed",
          ...base,
          evidence,
          ...(source === "compact" && { compacted: true }),
          ...(atPrompt.has(source ?? "") && { atPrompt: true }),
          ...(cwd !== undefined && { cwd }),
          ...(transcript !== undefined && { transcript }),
        },
      ]
    }
    case "UserPromptSubmit":
      // A subagent's prompt is its own work, not the root's turn; a background task's
      // result starts a turn by itself, as a task notification.
      if (actor) return []
      const prompt = text(payload.prompt) ?? ""
      return [promptStart(base, prompt, notification.test(prompt))]
    case "Stop":
      return actor
        ? []
        : [
            {
              type: "turn-ended",
              ...base,
              outcome: "completed",
              background: running(payload.background_tasks),
              ...replied(payload.last_assistant_message),
            },
          ]
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
          ...(payload.tool_input !== undefined && { input: payload.tool_input }),
          kind:
            tool === "AskUserQuestion"
              ? "question"
              : tool === "ExitPlanMode"
                ? "plan"
                : "permission",
        },
        ...presented(base, actor, tool, payload.tool_input),
      ]
    case "Elicitation": {
      // An MCP server asks the person for input, as a form: a request of its own, named
      // `mcp__<server>__elicitation`, which its ElicitationResult settles.
      const server = text(payload.mcp_server_name)
      if (!server) return []
      const name = elicitationTool(server)
      const input = {
        mcp_server_name: server,
        message: payload.message,
        mode: payload.mode,
        requested_schema: payload.requested_schema,
      }
      const message = text(payload.message)
      return [
        {
          type: "attention-requested",
          ...base,
          requestId: callId(actor, name, input),
          actor,
          toolName: name,
          subject: message?.slice(0, 1024) ?? null,
          choices: [],
          input,
          kind: "question",
        },
      ]
    }
    case "ElicitationResult": {
      const server = text(payload.mcp_server_name)
      if (!server) return []
      const name = elicitationTool(server)
      return [
        {
          type: "attention-resolved",
          ...base,
          requestId: callId(actor, name, null),
          actor,
          toolName: name,
          // The result doesn't repeat the form: it settles the actor's oldest.
          loose: true,
          outcome: "allowed",
        },
      ]
    }
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
        ...touched(base, actor, tool, payload.tool_input),
      ]
    case "StatusLine":
      return statusLine(base, payload)
    default:
      return []
  }
}

// The prompt of a turn Claude Code starts by itself once a background task finishes.
const notification = /^\s*<task-notification>/

/**
 * The background tasks a Stop lists still running, each of which starts a turn by itself
 * once done, with a task notification (probed 2026-10-04, 2.1.289: a background subagent
 * and a background command each did): its subagents, by their type, and the rest, as
 * commands. Each names its status, and only a running one counts.
 */
const running = (tasks: unknown): Background => {
  const listed = Array.isArray(tasks) ? (tasks as unknown[]) : []
  const live = listed.filter(
    (task): task is { type?: unknown } =>
      typeof task === "object" &&
      task !== null &&
      (task as { status?: unknown }).status === "running",
  )
  const agents = live.filter(({ type }) => type === "subagent").length
  return { agents, tasks: live.length - agents }
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

// Claude Code's rate-limit windows, by their names in its status line.
const windows = { five_hour: 300, seven_day: 10_080 } as const

/**
 * The status line Claude Code runs in Novadeck's shells hands over what no other source
 * says: the context window's size beside what it holds, the account's five-hour and
 * seven-day rate limits, used percentage and reset time in epoch seconds, and the model's
 * display name with its reasoning effort level, which it leaves out for a model without
 * one.
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
  const model = shortName(
    (payload.model as { display_name?: unknown } | undefined)?.display_name,
    128,
  )
  const effort = shortName((payload.effort as { level?: unknown } | undefined)?.level, 32)
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
      // A model with no effort parameter has no level, so a named model clears the last.
      ...(model !== undefined && { model, effort: effort ?? null }),
      ...(model === undefined && effort !== undefined && { effort }),
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

// A file a writer wrote or edited, by the absolute path its input names.
const touched = (
  base: { agent: "claude"; sessionId: string; instance: string | null; startedAt: number },
  actor: string | null,
  tool: string,
  input: unknown,
): HarnessEvent[] => {
  if (!writers.has(tool) && tool !== "NotebookEdit") return []
  const { file_path: file, notebook_path: notebook } = (input ?? {}) as Record<string, unknown>
  const path = absolute(file) ?? absolute(notebook)
  return path ? [{ type: "file-touched", ...base, actor, path }] : []
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
  return [{ type: "plan-observed", ...base, actor, plan: { kind: "text", ...bounded(plan) } }]
}

/**
 * The plans a transcript line presents for review, as its hooks would name them: what
 * reads back a plan presented as text, which no file holds, from its actor's transcript.
 */
export const transcriptPlans = (line: string): readonly WrittenPlan[] => {
  if (!line.includes('"ExitPlanMode"')) return []
  const fields = record(line)
  if (fields?.type !== "assistant") return []
  const time = writtenAt(fields.timestamp)
  const base = { agent: "claude", sessionId: "", instance: null, startedAt: time ?? 0 } as const
  const content = (fields.message as { content?: unknown } | undefined)?.content
  return (Array.isArray(content) ? content : []).flatMap((part) => {
    const { type, name, input } = (part ?? {}) as Record<string, unknown>
    if (type !== "tool_use" || typeof name !== "string") return []
    return presented(base, null, name, input).flatMap((event) =>
      event.type === "plan-observed" ? [{ source: event.plan, at: time }] : [],
    )
  })
}

export { maxPlan } from "../harness.js"
