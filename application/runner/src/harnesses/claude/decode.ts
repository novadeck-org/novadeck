import type { Report } from "../../shell/reports.js"
import type { HarnessEvent } from "../events.js"
import { absolute, callId, sessionId, sessionStart, text } from "../harness.js"

/**
 * Claude Code's hooks, as normalized facts.
 *
 * SessionStart names the session running in the terminal, unless it is not the
 * terminal's own: a subagent's (it carries `agent_id`), or Claude Code running inside
 * Cursor. A turn starts with UserPromptSubmit and ends with Stop, or StopFailure on an
 * API error; a subagent's stop ends only its own work. PermissionRequest asks the person
 * about a tool call, AskUserQuestion's as a question, for the root agent or a subagent;
 * the call's PostToolUse or PostToolUseFailure from that actor means it was allowed. An
 * answered question's call gains its answers, so its result matches loosely. A denial or
 * an Esc fires nothing: the next turn settles them.
 */
export const decode = ({ event, seq, instance, env, payload }: Report): readonly HarnessEvent[] => {
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
    case "PermissionRequest":
      return [
        {
          type: "attention-requested",
          ...base,
          requestId: callId(actor, tool, payload.tool_input),
          actor,
          toolName: tool,
          kind: tool === "AskUserQuestion" ? "question" : "permission",
        },
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
          loose: tool === "AskUserQuestion",
          outcome: "allowed",
        },
      ]
    default:
      return []
  }
}
