import type { AgentName, DeliveryState } from "@novadeck/protocol"

import type { AgentSetup } from "./agents/agent.js"

/**
 * The known gaps in harness parity the end-to-end suite works around (see
 * docs/e2e-testing.md, "Known gaps"). Each is pinned by a test that asserts today's wrong
 * behaviour, and the scenarios ask these functions rather than which harness they run, so
 * fixing one means deleting its agent here and following its entry's note.
 */
type Gap = {
  /** The harnesses it affects. */
  readonly agents: readonly AgentName[]
}

/**
 * A Codex at its first screen can't be rung. Wide and tall enough, Codex draws a logo
 * there and erases it as soon as anything lands in its input box, so the doorbell's test
 * paste changes rows far from its line and the ring fails, as it should when it can't
 * tell what the paste did: the recipient ends Unknown, its message still queued. The
 * round trip gives such a recipient a first turn so it is Settled when rung.
 *
 * Pinned in codex.e2e.ts ("can't ring a Codex still at its first screen"). Once the
 * doorbell rings such a Codex, that test fails: assert there that the recipient is
 * Working with the message delivered, and remove Codex here, which drops that first turn.
 */
export const unrungAtFirstScreen: Gap = { agents: ["codex"] }

/**
 * Antigravity often ends a turn Unknown. Its status line still says it is working 10 to
 * 60 ms after its Stop hook, which NovaDeck takes for the turn going on; the idle that
 * follows then leaves the terminal Unknown, never rung, in about two turns in five. So a
 * turn's end is Settled or Unknown, and in the round trip the sender holds its turn open
 * until the answer is sent, so the answer comes as its Stop continuation rather than a
 * ring it might never get.
 *
 * Pinned in src/messaging/messaging.test.ts ("is left Unknown when its status line says
 * working just after a Stop, then idle"). Once fixed, that test fails: assert Settled
 * there, and remove Antigravity here, so its turns end Settled alone and the sender's
 * turn ends for the doorbell to bring the answer.
 */
export const unknownTurnEnd: Gap = { agents: ["agy"] }

const has = (gap: Gap, setup: AgentSetup): boolean => gap.agents.includes(setup.agent)

/** Whether the doorbell rings the harness at its first screen, Ready before any turn. */
export const ringsAtReady = (setup: AgentSetup): boolean => !has(unrungAtFirstScreen, setup)

/** Whether a turn that ended leaves the harness where the doorbell reliably rings it. */
export const ringsAfterTurn = (setup: AgentSetup): boolean => !has(unknownTurnEnd, setup)

/** The delivery states the harness may show once a turn ends. */
export const turnEnds = (setup: AgentSetup): readonly DeliveryState[] =>
  has(unknownTurnEnd, setup) ? ["settled", "unknown"] : ["settled"]
