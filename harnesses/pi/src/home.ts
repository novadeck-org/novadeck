import { posix, win32 } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"

/**
 * Where pi keeps its files: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`, on every platform
 * (src/config.ts of its coding-agent package, 1.6.0, read 2026-11-24). `install.env` is the person's
 * own environment, which may move it. Novadeck never sets it for the person's pi.
 */
export const agentDir = ({
  env,
  home,
  platform,
}: Pick<Install, "env" | "home" | "platform">): string => {
  const rules = platform === "win32" ? win32 : posix
  const moved = env.PI_CODING_AGENT_DIR
  if (moved)
    return moved === "~" ? home : moved.startsWith("~/") ? rules.join(home, moved.slice(2)) : moved
  return rules.join(home, ".pi", "agent")
}

/** Its home, whose presence says it has run: its agent folder (settings, logins, sessions). */
export const home = (install: Pick<Install, "env" | "home" | "platform">): string =>
  agentDir(install)
