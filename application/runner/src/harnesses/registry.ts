import type { Harness } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { agy } from "./agy/index.js"
import { claude } from "./claude/index.js"
import { codex } from "./codex/index.js"

/** Every harness Novadeck integrates, by the agent name clients know it by. */
export const harnesses: { readonly [agent in AgentName]: Harness } = { claude, codex, agy }

export const agents = Object.keys(harnesses) as AgentName[]
