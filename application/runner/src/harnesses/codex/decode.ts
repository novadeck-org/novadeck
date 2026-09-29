import type { Report } from "../../shell/reports.js"
import type { HarnessEvent } from "../events.js"
import { absolute, sessionId, sessionStart } from "../harness.js"

/**
 * Codex's hooks, as normalized facts. SessionStart names the session running in the
 * terminal, unless a Codex started it: that one runs with another thread in
 * CODEX_THREAD_ID.
 */
export const decode = ({ event, seq, instance, env, payload }: Report): readonly HarnessEvent[] => {
  if (event !== "SessionStart") return []
  const id = sessionId(payload.session_id)
  if (!id || (env.codexThread !== undefined && env.codexThread !== id)) return []
  const cwd = absolute(payload.cwd)
  const source = typeof payload.source === "string" ? payload.source : undefined
  return [
    {
      type: "session-observed",
      agent: "codex",
      sessionId: id,
      evidence: sessionStart(source),
      startedAt: seq,
      instance,
      ...(cwd !== undefined && { cwd }),
    },
  ]
}
