import type { Report } from "../../shell/reports.js"
import type { HarnessEvent } from "../events.js"
import { absolute, callId, sessionId, sessionStart, text } from "../harness.js"

/**
 * Codex's hooks, as normalized facts.
 *
 * SessionStart names the session running in the terminal, unless a Codex started it: that
 * one runs with another thread in CODEX_THREAD_ID. A turn starts with UserPromptSubmit and
 * ends with Stop, or Interrupt when the person pressed Esc, which also answers "no" to a
 * waiting request. PermissionRequest asks about a tool call, for the root agent or a
 * subagent; the call's PostToolUse from that actor means it was allowed. Codex describes
 * a shell call in the request but not in its result, so a call is known by its command.
 */
export const decode = ({ event, seq, instance, env, payload }: Report): readonly HarnessEvent[] => {
  const id = sessionId(payload.session_id)
  if (!id || (env.codexThread !== undefined && env.codexThread !== id)) return []
  const base = { agent: "codex", sessionId: id, instance, startedAt: seq } as const
  const tool = text(payload.tool_name) ?? ""
  const actor = text(payload.agent_id) ?? null
  const input = payload.tool_input
  const call =
    typeof input === "object" && input !== null && "command" in input
      ? { command: (input as { command: unknown }).command }
      : input
  switch (event) {
    case "SessionStart": {
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
      // A subagent's stop ends its own work, not the turn.
      return actor ? [] : [{ type: "turn-ended", ...base, outcome: "completed" }]
    case "Interrupt":
      // A subagent's own interrupt ends its work, not the turn.
      return actor ? [] : [{ type: "turn-ended", ...base, outcome: "interrupted" }]
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
          requestId: callId(actor, tool, call),
          actor,
          toolName: tool,
          kind: "permission",
        },
      ]
    case "PostToolUse":
      return [
        {
          type: "attention-resolved",
          ...base,
          requestId: callId(actor, tool, call),
          actor,
          toolName: tool,
          loose: false,
          outcome: "allowed",
        },
      ]
    default:
      return []
  }
}
