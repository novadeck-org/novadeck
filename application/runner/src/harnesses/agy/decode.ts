import type { Report } from "../../shell/reports.js"
import type { HarnessEvent } from "../events.js"
import { absolute, sessionId, text } from "../harness.js"

/**
 * Antigravity's hooks, as normalized facts. Every hook names the conversation it runs in,
 * and nothing says how it began: /clear and /resume switch conversations in one process.
 * PreInvocation starts a model call, so the agent works; Stop ends the turn, as failed
 * when it names an error. Its confirmations fire no hook, and an Esc fires nothing.
 */
export const decode = ({ event, seq, instance, payload }: Report): readonly HarnessEvent[] => {
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
