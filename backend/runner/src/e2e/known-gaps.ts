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
 * pi on Windows the same (Windows CI, 1.6.0, 2026-11-24: twelve `\n` keys left its box one row,
 * the draft not sent); a person's Shift+Enter still adds one, as pi reads the Shift key itself
 * there (its docs/terminal-setup.md).
 */
const lineBreakKeysLost: Gap = { agents: ["codex", "pi"], platforms: ["win32"] }

/** Whether a line break typed as a key of its own adds no line to the harness's box. */
export const losesLineBreakKeys = (setup: AgentSetup): boolean => has(lineBreakKeysLost, setup)

/**
 * pi on Windows asks its terminal for the kitty keyboard protocol, and the ConPTY Novadeck's
 * terminals run on there gives it: a line feed written in a bracketed paste reaches pi as
 * Ctrl+Enter's keys (`ESC[13;5u` and the Ctrl key's release), which its paste shows as text
 * (Windows CI, 1.6.0, 2026-11-24: `[13;5u[57442;1:3u…MY DRAFT` in the box). A return goes in
 * as a line break, as Novadeck's own pastes write one (`inPaste`) and a person's paste is
 * written by the terminal, so only a scenario's own paste of line feeds is touched.
 * Pinned by doorbell.e2e's "never rings over a draft under blank rows" and inbox.e2e's "rings
 * nothing over a draft scrolled out of sight", which paste returns there; once a line feed
 * pastes as one, they paste it as elsewhere.
 */
const lineFeedPastedAsKeys: Gap = { agents: ["pi"], platforms: ["win32"] }

/** The line break a scenario pastes as its own: a line feed, or a return where one is taken as keys. */
export const pastedLineBreak = (setup: AgentSetup): string =>
  has(lineFeedPastedAsKeys, setup) ? "\r" : "\n"
