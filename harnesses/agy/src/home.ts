import { join } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"

/** Where Antigravity keeps its state, beside other Google tools': `~/.gemini`. */
export const geminiHome = ({ home }: Pick<Install, "home">): string => join(home, ".gemini")

/** Antigravity's home: its settings, which hold its status line and the folders it trusts. */
export const antigravityHome = (install: Pick<Install, "home">): string =>
  join(geminiHome(install), "antigravity-cli")
