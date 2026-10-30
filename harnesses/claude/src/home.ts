import { join } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"

/**
 * Claude Code's configuration folder: its settings, its plugins and its plans.
 * `CLAUDE_CONFIG_DIR` moves it from `~/.claude`.
 */
export const claudeHome = ({ env, home }: Pick<Install, "env" | "home">): string =>
  env.CLAUDE_CONFIG_DIR || join(home, ".claude")
