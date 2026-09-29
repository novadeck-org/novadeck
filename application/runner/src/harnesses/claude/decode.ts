import type { Report } from "../../shell/reports.js"
import type { HarnessEvent } from "../events.js"
import { absolute, sessionId, sessionStart } from "../harness.js"

/**
 * Claude Code's hooks, as normalized facts. SessionStart names the session running in the
 * terminal, unless it is not the terminal's own: a subagent's (it carries `agent_id`), or
 * Claude Code running inside Cursor.
 */
export const decode = ({ event, seq, instance, env, payload }: Report): readonly HarnessEvent[] => {
  if (event !== "SessionStart") return []
  const id = sessionId(payload.session_id)
  if (!id || payload.agent_id !== undefined || payload.cursor_version !== undefined || env.cursor)
    return []
  const cwd = absolute(payload.cwd)
  const source = typeof payload.source === "string" ? payload.source : undefined
  return [
    {
      type: "session-observed",
      agent: "claude",
      sessionId: id,
      evidence: sessionStart(source),
      startedAt: seq,
      instance,
      ...(cwd !== undefined && { cwd }),
    },
  ]
}
