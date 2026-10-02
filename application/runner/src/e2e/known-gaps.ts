import type { AgentName } from "@novadeck/protocol"

import type { AgentSetup } from "./agents/agent.js"

/**
 * The known gaps in harness parity the end-to-end suite works around (see
 * docs/e2e-testing.md, "Known gaps"). None stands today.
 *
 * A gap is a `Gap` exported here, documented with its cause, the test that pins today's
 * wrong behaviour, and what to assert once it is fixed. The scenarios never ask which
 * harness they run: they ask a function built on `has`, named for the behaviour that
 * differs, and take the detour it picks. Fixing a gap means deleting its entry, that
 * function and the detour, and turning its pin into the real assertion.
 */
export type Gap = {
  /** The harnesses it affects. */
  readonly agents: readonly AgentName[]
}

/** Whether the gap affects the setup's harness. */
export const has = (gap: Gap, setup: AgentSetup): boolean => gap.agents.includes(setup.agent)
