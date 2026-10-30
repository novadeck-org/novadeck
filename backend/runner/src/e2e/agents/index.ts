import { agentNames, type AgentName } from "@novadeck/protocol"

import type { AgentSetup } from "./agent.js"
import { agy } from "./agy.js"
import { claude } from "./claude.js"
import { codex } from "./codex.js"

// Keyed by agent, so a harness the protocol names without a setup here fails to compile.
const byAgent: { readonly [agent in AgentName]: AgentSetup } = { claude, codex, agy }

/** Every harness's setup, in the protocol's order, as the suite runs and names them. */
export const setups: readonly AgentSetup[] = agentNames.map((agent) => byAgent[agent])
