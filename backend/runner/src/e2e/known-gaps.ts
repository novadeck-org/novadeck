import type { AgentName } from "@novadeck/protocol"

import type { AgentSetup } from "./agents/agent.js"

/**
 * The known gaps in harness parity the end-to-end suite works around (see
 * docs/e2e-testing.md, "Known gaps").
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
  /** The platforms it affects; every one when omitted. */
  readonly platforms?: readonly NodeJS.Platform[]
}

/** Whether the gap affects the setup's harness, on this platform. */
export const has = (gap: Gap, setup: AgentSetup): boolean =>
  gap.agents.includes(setup.agent) &&
  (gap.platforms === undefined || gap.platforms.includes(process.platform))

/**
 * Codex on Windows mostly never gets a character outside Unicode's Basic Multilingual Plane, as
 * the emoji 👨, through the ConPTY that node-pty bundles and Novadeck's terminals run on
 * there: it reads the console's keys, and the character's two UTF-16 halves never reach
 * it, though the joiners between such emoji do (probed 2026-10-09: Codex 0.159.3,
 * OpenConsole 1.25.260303002; Windows' own ConPTY delivers it, as both deliver it to
 * cmd). A prompt holding one never shows whole in its box, so Novadeck presses no Enter
 * and the prompt fails (PROMPT_FAILED), what was pasted left in the box as a draft the
 * next prompt goes along with. Not every time: one CI run of
 * many (2026-10-10) got it through, the prompt landing as on Linux. Pinned by chat.e2e.ts, "gives its agent
 * emoji sequences and CJK, then the next prompt", which takes either. Once fixed, the
 * prompt lands every time and its turn runs as on Linux.
 */
const astralLost: Gap = { agents: ["codex"], platforms: ["win32"] }

/** Whether the harness loses a character outside the BMP that a prompt pastes. */
export const losesAstral = (setup: AgentSetup): boolean => has(astralLost, setup)

/**
 * Antigravity on Windows, two of it starting together in one home, may read its settings
 * as the other rewrites them, and show its first-run onboarding in place of the
 * folder-trust question (seen once on a Windows CI runner, 2026-10-10, 1.2.14): its own
 * settings write, not anything of Novadeck's. controls.e2e.ts, "never rings an agent at
 * its folder-trust question", starts the second once the first asks there; elsewhere both
 * start together, as a workspace restored. A race, it has no pin that fails every time;
 * once Antigravity writes its settings whole, drop the stagger.
 */
const settingsRaced: Gap = { agents: ["agy"], platforms: ["win32"] }

/** Whether two of the harness starting together may race on its own settings. */
export const racesOwnSettings = (setup: AgentSetup): boolean => has(settingsRaced, setup)

/**
 * Codex on Windows reads the console's keys, and a line break written as a key of its own adds no
 * line to its box (seen on Windows CI, 0.167.0, 2026-11-07): only one in what it takes for a burst
 * of typing does (`pastesWhole`). Pinned by inbox.e2e's "rings nothing over a draft scrolled out
 * of sight", which pastes the draft there; once such a key adds a line, it types it as elsewhere.
 */
const lineBreakKeysLost: Gap = { agents: ["codex"], platforms: ["win32"] }

/** Whether a line break typed as a key of its own adds no line to the harness's box. */
export const losesLineBreakKeys = (setup: AgentSetup): boolean => has(lineBreakKeysLost, setup)

/**
 * Claude Code on Windows leaves a process of its own running once its agents view opens: a
 * `claude.exe` under `WmiPrvSE`, so started apart from the terminal, which outlived the deck (seen
 * on Windows CI, 2.1.316, 2026-11-07; that the view starts it is read from it being the one test
 * that opens the view). inbox.e2e's view test runs on the others; what it reads doesn't differ.
 */
const agentsViewStaysBehind: Gap = { agents: ["claude"], platforms: ["win32"] }

/** Whether opening the harness's agents view leaves a process behind that outlives the deck. */
export const agentsViewOutlivesDeck = (setup: AgentSetup): boolean =>
  has(agentsViewStaysBehind, setup)
