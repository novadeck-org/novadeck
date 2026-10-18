import { agy } from "@novadeck/harness-agy/index"
import { claude } from "@novadeck/harness-claude/index"
import { codex } from "@novadeck/harness-codex/index"
import type { Harness } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

/** Every harness Novadeck integrates, by the agent name clients know it by. */
export const harnesses: { readonly [agent in AgentName]: Harness } = { claude, codex, agy }

export const agents = Object.keys(harnesses) as AgentName[]
