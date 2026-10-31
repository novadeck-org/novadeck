import { join } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"

/**
 * Codex's home: its configuration, its plugin cache, its models' cache and its threads'
 * locks. `CODEX_HOME` moves it from `~/.codex`.
 */
export const codexHome = ({ env, home }: Pick<Install, "env" | "home">): string =>
  env.CODEX_HOME || join(home, ".codex")
