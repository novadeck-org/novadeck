import { randomBytes } from "node:crypto"

/**
 * The doorbell's checks of a terminal's screen (see docs/agent-messaging.md, "The
 * doorbell"), the same for every TUI: they know nothing of how a harness draws its
 * screen, only the screen's text before and after a test paste.
 */

/** How far from the line's rows a row may change as it lands: footer hints, a placeholder. */
export const nearRows = 3

/** A fresh nonce for one ring, short and unguessable enough to tell its prompt. */
export const freshNonce = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  return [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join("")
}

/** The line written as one bracketed paste, which the TUI takes as text, never as keys. */
export const bracketedPaste = (line: string): string => `\x1b[200~${line}\x1b[201~`

/** Text without its whitespace, as a TUI may wrap the line anywhere and indent the rest. */
const compact = (text: string): string => text.replace(/\s+/g, "")

/**
 * Where the line is on the screen, joined across the rows it wraps over, whitespace
 * aside: the first and last rows of each place it appears.
 */
export const findLine = (
  rows: readonly string[],
  line: string,
): readonly { readonly first: number; readonly last: number }[] => {
  const needle = compact(line)
  if (!needle) return []
  let joined = ""
  const rowOf: number[] = []
  for (const [index, row] of rows.entries()) {
    const text = compact(row)
    joined += text
    for (let char = 0; char < text.length; char += 1) rowOf.push(index)
  }
  const found: { first: number; last: number }[] = []
  for (let at = joined.indexOf(needle); at >= 0; at = joined.indexOf(needle, at + 1))
    found.push({ first: rowOf[at]!, last: rowOf[at + needle.length - 1]! })
  return found
}

/** Whether two rows read the same, trailing blanks aside. */
const same = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? "").trimEnd() === (b ?? "").trimEnd()

/** What a test paste showed: accepted, with the rows the line took; or why not. */
export type PasteCheck =
  | { readonly accepted: true; readonly first: number; readonly last: number }
  | { readonly accepted: false; readonly reason: "absent" | "repeated" | "before" | "elsewhere" }

/**
 * Whether a test paste landed where Enter would submit it alone: the line appears on the
 * screen exactly once, and didn't before, and every row that changed is one it takes or
 * within `nearRows` of them. Where the box grew a row, the rows above it may have moved
 * up one and those below down one; they are compared moved.
 */
export const checkPaste = (
  before: readonly string[],
  after: readonly string[],
  line: string,
): PasteCheck => {
  if (findLine(before, line).length > 0) return { accepted: false, reason: "before" }
  const found = findLine(after, line)
  if (found.length === 0) return { accepted: false, reason: "absent" }
  if (found.length > 1) return { accepted: false, reason: "repeated" }
  const { first, last } = found[0]!
  if (before.length !== after.length) return { accepted: false, reason: "elsewhere" }
  const unchanged = (up: number, down: number) =>
    after.every((row, index) => {
      if (index < first - nearRows) return same(row, before[index + up])
      if (index > last + nearRows) return same(row, before[index - down])
      return true
    })
  return unchanged(0, 0) || unchanged(1, 0) || unchanged(0, 1) || unchanged(1, 1)
    ? { accepted: true, first, last }
    : { accepted: false, reason: "elsewhere" }
}

/** What the gate needs to know of a terminal before it rings. */
export type GateFacts = {
  /** Whether messaging says it may ring: Settled or Ready, untouched, with messages waiting. */
  readonly ringable: boolean
  /** How long its screen's text has been unchanged, in milliseconds. */
  readonly calmMs: number
  readonly bracketedPaste: boolean
  /** Whether the bound instance holds the foreground; undefined where the platform can't tell. */
  readonly foreground: boolean | undefined
}

/** How long a screen must be still before the doorbell rings, in milliseconds. */
export const calmMs = 750

/** Why the gate is shut, or `open`. */
export const gate = (
  facts: GateFacts,
  still = calmMs,
): "open" | "not-ringable" | "restless" | "no-bracketed-paste" | "not-foreground" => {
  if (!facts.ringable) return "not-ringable"
  if (facts.calmMs < still) return "restless"
  if (!facts.bracketedPaste) return "no-bracketed-paste"
  if (facts.foreground === false) return "not-foreground"
  return "open"
}
