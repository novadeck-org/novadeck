import type { PromptShown } from "@novadeck/harness-core/events"
import type { Harness } from "@novadeck/harness-core/harness"

/**
 * pi's startup (probed 2026-11-24, 1.6.0, fixtures/startup.probe.json and dialogs.probe.json). It
 * has no onboarding and no sign-in screen: with no provider it starts into its TUI all the same,
 * the box ready. One screen of its own holds it before then: in a folder whose `.pi` holds what a
 * project brings (settings, extensions, MCP servers, skills…), it asks first whether to trust it,
 * on the normal screen, before its TUI starts and before it sets its title:
 *
 *      Trust project folder?
 *      /home/a/project
 *
 *      This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.
 *
 *      → Trust
 *        Trust parent folder (/home/a)
 *        Trust (this session only)
 *        Do not trust
 *        Do not trust (this session only)
 *
 *      ↑↓ navigate  enter select  escape/ctrl+c cancel
 *
 * The person answers it there (Novadeck's extension answers it only for a worktree of a folder
 * they trust, design.md 9); while it shows, nothing Novadeck sends reaches pi.
 */
const trustTitle = /^\s*Trust project folder\?\s*$/

export const heldScreen: NonNullable<Harness["heldScreen"]> = (rows) =>
  rows.some((row) => trustTitle.test(row)) ? "startup" : undefined

/**
 * With no provider it can reach, it says so in its transcript, `Warning: No models available. Use
 * /login to log into a provider via OAuth or API key.`, and its footer names no model, `unknown` at
 * the right end of its last row; a prompt then fails, `Error: No API key found for the selected
 * model.` (`empty`, `emptyEnter` of fixtures/startup.probe.json). The footer stays while the
 * warning scrolls away, so it decides; the footer's model is the last word on its row, after
 * at least two spaces, which a reply never draws there.
 */
const noModel = /\S\s{2,}unknown\s*$/

export const signedOut: NonNullable<Harness["signedOut"]> = (rows) => {
  const drawn = rows.filter((row) => row.trim() !== "")
  return drawn.slice(-3).some((row) => noModel.test(row))
}

/**
 * The terminal title pi sets as its TUI starts: `π - <folder>`, and `π - <session name> - <folder>`
 * once the session is named (probed 2026-11-24, 1.6.0: about 20 ms after it entered its alternate
 * screen and drew its box, and never again for a turn). It comes after the trust prompt, so it
 * says the prompt shows.
 */
export const title = (text: string, at: number): PromptShown | undefined =>
  text.startsWith("π - ")
    ? { type: "prompt-shown", agent: "pi", instance: null, startedAt: at }
    : undefined

/**
 * Its version, as the header at the top of its transcript draws it on every start, a resume's
 * too: ` ▀▀█  v1.6.0`, the logo's first row (probed 2026-11-24, 1.0.0 to 1.6.0; 0.87.1 drew
 * ` pi v0.87.1`, older than any Novadeck works with).
 */
const header = /^ ?▀▀█ {2}v(\d+\.\d+\.\d+\S*)\s*$/

export const screenVersion: NonNullable<Harness["screenVersion"]> = (rows) => {
  for (const row of rows) {
    const found = header.exec(row)
    if (found) return found[1]
  }
  return undefined
}

/** Where its header's version line starts: its logo's first row, at its second column. */
export const screenMarker: NonNullable<Harness["screenMarker"]> = { text: "▀▀█", columns: 4 }
