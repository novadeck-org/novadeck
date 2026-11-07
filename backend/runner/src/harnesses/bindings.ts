import type { SessionObserved, TelemetryObserved } from "@novadeck/harness-core/events"
import type { AgentName } from "@novadeck/protocol"

import type { AgentReport } from "../terminals/saved-terminals.js"

/**
 * The harness session that holds a terminal's foreground since the shell's last prompt.
 * It is live state: a prompt, exit, restart or disconnection ends it, and it is never saved.
 */
export type Binding = {
  readonly agent: AgentName
  readonly sessionId: string
  /** The harness process that reported it; null where the platform hides it. */
  readonly instance: string | null
  /**
   * The version of the harness that wrote the session's transcript, as its own records say
   * (`TelemetryObserved.version`); absent while unknown, as before the first record, and then
   * `versionOf` gives null. It stays with the session, never with the terminal: a new one
   * is unknown until its records say.
   */
  readonly version?: string
  /** That `version` is the release that created the session, which a resume may not run. */
  readonly created?: true
}

/** The harness version a binding knows, or null while it does not. */
export const versionOf = (binding: Pick<Binding, "version"> | null | undefined): string | null =>
  binding?.version ?? null

/**
 * The binding after a record naming a version: with the version where the record names the
 * bound session (and process, where both tell), else the binding itself. The release that
 * created a session (`created`) gives way to one read of the running process, and never
 * replaces it.
 */
export const withVersion = (binding: Binding, event: TelemetryObserved): Binding => {
  const { version } = event
  if (
    version === undefined ||
    binding.agent !== event.agent ||
    binding.sessionId !== event.sessionId ||
    (binding.instance !== null && event.instance !== null && binding.instance !== event.instance) ||
    (event.created && binding.version !== undefined && !binding.created) ||
    (binding.version === version && Boolean(binding.created) === Boolean(event.created))
  )
    return binding
  const { created: _, ...rest } = binding
  return { ...rest, version, ...(event.created && { created: true as const }) }
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
  /**
   * Whether the bound session's agent works on a turn, or has work its turn left running:
   * another conversation it observes then is that work's own, as an Antigravity subagent's.
   */
  readonly busy?: boolean
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
 * `agy -p`'s status line drawn as it exits. While the bound agent is busy, a conversation
 * it observes that its harness doesn't name the root is a subagent's (Antigravity's hooks
 * name a subagent's conversation as they name the root's, probed 2026-10-04, 1.2.14): only
 * a switch it announced, or its status line naming the root, replaces the bound one then.
 */
const replaces = (binding: Binding, event: SessionObserved, busy: boolean): boolean => {
  if (binding.agent !== event.agent) return false
  if (
    busy &&
    event.evidence === "conversation-observed" &&
    event.root !== true &&
    binding.sessionId !== event.sessionId
  )
    return false
  if (binding.instance !== null && event.instance !== null && binding.instance !== event.instance)
    return false
  if (binding.instance !== null && event.instance === null)
    return binding.sessionId === event.sessionId
  return binding.sessionId === event.sessionId || event.evidence !== "startup"
}

/**
 * The flags a session was launched with after a process of it reports `told`: a resume gives
 * back only what the harness forgets, so the process that resumed it tells a part of what
 * the session was launched with, and the rest stays. A flag the process tells again takes
 * its value. Flags are words that start with `-`, each with the value after it, if any.
 */
export const mergeLaunch = (
  known: readonly string[] | undefined,
  told: readonly string[] | undefined,
): readonly string[] | undefined => {
  if (told === undefined) return known
  const units = (words: readonly string[]): [string, string[]][] => {
    const found: [string, string[]][] = []
    for (const word of words) {
      const last = found.at(-1)
      if (word.startsWith("-") || last === undefined) {
        found.push([word, [word]])
      } else last[1].push(word)
    }
    // A config override is named by its key as well, as several differ by it.
    return found.map(([flag, own]): [string, string[]] => [
      flag === "-c" || flag === "--config" ? `${flag}:${own[1]?.split("=", 1)[0] ?? ""}` : flag,
      own,
    ])
  }
  const merged = new Map(units(known ?? []))
  for (const [flag, own] of units(told)) merged.set(flag, own)
  return [...merged.values()].flat()
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
  if (state.binding && !replaces(state.binding, event, facts.busy === true)) return undefined
  const known = state.sessions[event.agent]
  if (known && known.seq >= event.startedAt) return undefined
  // What the session was doing, what it was told and when its last turn ended stay with it as
  // it reports again: only a new session starts without (`AgentReport.turn`, `told`, `endedAt`).
  const same = known?.sessionId === event.sessionId
  // The same session reporting again is still written by the same release.
  const kept =
    state.binding?.agent === event.agent && state.binding.sessionId === event.sessionId
      ? state.binding
      : undefined
  const turn = same ? known.turn : undefined
  const told = same ? known.told : undefined
  const endedAt = same ? known.endedAt : undefined
  // Where it bound stays its folder: a harness looks a conversation up by it, so a resume
  // must run there, whatever directory a later report names.
  const cwd = (same && known.cwd) || event.cwd || state.cwd
  // Where its harness keeps the conversation, as it named it: a hint for finding it again.
  const transcript = event.transcript ?? (same ? known.transcript : undefined)
  // The flags its process was launched with, as that process tells them; a report that can't
  // (the relay couldn't read them) leaves what the session had.
  const launch = same ? mergeLaunch(known.launch, event.launch) : event.launch
  const sessions = {
    ...state.sessions,
    [event.agent]: {
      sessionId: event.sessionId,
      seq: event.startedAt,
      cwd,
      ...(transcript && { transcript }),
      ...(turn && { turn }),
      ...(told && { told }),
      ...(endedAt !== undefined && { endedAt }),
      ...(launch !== undefined && launch.length > 0 && { launch }),
    },
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
          ...(kept?.version !== undefined && { version: kept.version }),
          ...(kept?.created && { created: true as const }),
        },
        cwd: event.cwd ?? state.cwd,
      }
    : { ...state, sessions }
}
