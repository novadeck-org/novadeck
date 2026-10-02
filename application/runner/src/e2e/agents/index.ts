import type { AgentSetup } from "./agent.js"
import { agy } from "./agy.js"
import { claude } from "./claude.js"
import { codex } from "./codex.js"

/** Every harness's setup, in the order the suite runs and names them. */
export const setups: readonly AgentSetup[] = [claude, codex, agy]
