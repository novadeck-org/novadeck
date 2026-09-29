import type { Report } from "../../shell/reports.js"
import type { HarnessEvent } from "../events.js"
import { absolute, sessionId } from "../harness.js"

/**
 * Antigravity's hooks, as normalized facts. Every hook names the conversation it runs in,
 * and nothing says how it began: /clear and /resume switch conversations in one process.
 */
export const decode = ({ seq, instance, payload }: Report): readonly HarnessEvent[] => {
  const id = sessionId(payload.conversationId)
  if (!id) return []
  const workspaces = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []
  const cwd = absolute(workspaces[0])
  return [
    {
      type: "session-observed",
      agent: "agy",
      sessionId: id,
      evidence: "conversation-observed",
      startedAt: seq,
      instance,
      ...(cwd !== undefined && { cwd }),
    },
  ]
}
