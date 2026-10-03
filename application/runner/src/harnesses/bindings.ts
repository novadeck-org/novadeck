import type { AgentName } from "@novadeck/protocol"

import type { AgentReport } from "../terminals/records.js"
import type { SessionObserved } from "./events.js"

/**
 * The harness session that holds a terminal's foreground since the shell's last prompt.
 * It is live state: a prompt, exit, restart or disconnection ends it, and it is never saved.
 */
export type Binding = {
  readonly agent: AgentName
  readonly sessionId: string
  /** The harness process that reported it; null where the platform hides it. */
  readonly instance: string | null
}

/** What a terminal knows of its harness sessions, which an observation may change. */
export type Sessions = {
  /** The latest session each harness reported, which a restored terminal resumes. */
  readonly sessions: { readonly [agent in AgentName]?: AgentReport }
  readonly binding: Binding | null
  readonly cwd: string
}

/** What the runner can tell about the terminal as an observation arrives. */
export type Facts = {
  /** When the shell last showed its prompt, in epoch milliseconds. */
  readonly promptedAt: number | null
  /** Whether the shell itself holds the foreground; undefined where the platform hides it. */
  readonly shellInForeground: boolean | undefined
  /** Whether a line was entered since the last prompt, for platforms that hide the foreground. */
  readonly submitted: boolean
  /** Whether the observing harness is connected; a disconnected one's reports are ignored. */
  readonly connected: boolean
  readonly platform: NodeJS.Platform
}

/**
 * Whether an observation may replace the bound session. Only the same harness process
 * can: with the same session, a switch it announced itself (/clear, /resume), or a
 * conversation it observed (Antigravity reports no source). Another process of the same
 * harness is a nested one, as is a fresh start while a session is bound: a subagent's, a
 * Codex started by another Codex, or an agent run from the one in the foreground. Where
 * the platform hides the process, the harness alone has to do. A report that can't tell
 * its process while the bound one is known, as from a hook outliving its agent, refreshes
 * the bound session at most: it may be a nested run's that just ended, as a nested
 * `agy -p`'s status line drawn as it exits.
 */
const replaces = (binding: Binding, event: SessionObserved): boolean => {
  if (binding.agent !== event.agent) return false
  if (binding.instance !== null && event.instance !== null && binding.instance !== event.instance)
    return false
  if (binding.instance !== null && event.instance === null)
    return binding.sessionId === event.sessionId
  return binding.sessionId === event.sessionId || event.evidence !== "startup"
}

/**
 * The terminal's sessions after an observation, or undefined when it is not this
 * terminal's own or not the latest. Processes that merely inherited the terminal's
 * environment report too: a tmux server or an editor started from it, while its shell
 * holds the foreground (Windows does not tell, so there a harness counts only once a line
 * was entered). A hook started before the last prompt records its session for resuming
 * but binds nothing. A bound session's directory is where the terminal restores, as a
 * shell that ran `cd … && claude` shows no prompt there.
 */
export const observe = (
  state: Sessions,
  event: SessionObserved,
  facts: Facts,
): Sessions | undefined => {
  if (!facts.connected) return undefined
  if (facts.shellInForeground) return undefined
  if (facts.platform === "win32" && !facts.submitted) return undefined
  if (state.binding && !replaces(state.binding, event)) return undefined
  const known = state.sessions[event.agent]
  if (known && known.seq >= event.startedAt) return undefined
  const sessions = {
    ...state.sessions,
    [event.agent]: { sessionId: event.sessionId, seq: event.startedAt },
  }
  return event.startedAt > (facts.promptedAt ?? 0)
    ? {
        sessions,
        binding: {
          agent: event.agent,
          sessionId: event.sessionId,
          // A report that can't tell its process, as from a hook outliving its agent, is
          // of the bound one where one is (`replaces`): what is known of it stays, so its
          // exit can still be told.
          instance: event.instance ?? state.binding?.instance ?? null,
        },
        cwd: event.cwd ?? state.cwd,
      }
    : { ...state, sessions }
}
