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

/**
 * Removes the variables a child must not inherit (see `inherited`) from `env` itself. On
 * Windows names have no case, so `novadeck_token` goes as well as `NOVADECK_TOKEN`.
 */
export const stripInherited = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): void => {
  if (platform !== "win32") {
    for (const name of inherited) delete env[name]
    return
  }
  const names = new Set(inherited.map((name) => name.toUpperCase()))
  for (const name of Object.keys(env)) if (names.has(name.toUpperCase())) delete env[name]
}

/** `env` without the variables a child must not inherit (see `inherited`). */
export const withoutInherited = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  const kept = { ...env }
  stripInherited(kept, platform)
  return kept
}
