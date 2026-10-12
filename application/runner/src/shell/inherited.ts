import { harnesses } from "@novadeck/protocol"

/**
 * Variables of Novadeck's own shells and of agent sessions, which a runner started from
 * inside one must not pass on to what it starts.
 */
export const inherited = [
  "NOVADECK_TOKEN",
  "NOVADECK_TERMINAL_ID",
  "NOVADECK_REPORT",
  "NOVADECK_REPORT_TOKEN",
  "NOVADECK_HOOK",
  "NOVADECK_MCP",
  "NOVADECK_BIN",
  "NOVADECK_ZDOTDIR",
  "NOVADECK_RESUME",
  "NOVADECK_SHIMS",
  // An agent's own session markers, when Novadeck was started from inside one: an agent
  // in Novadeck's shells would take itself for that session's child. Claude Code, for
  // one, then stops saving its transcript.
  ...harnesses.flatMap(({ inheritedEnv }) => inheritedEnv),
] as readonly string[]

/** `env` without the variables a child must not inherit (see `inherited`). */
export const withoutInherited = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const kept = { ...env }
  for (const name of inherited) delete kept[name]
  return kept
}
