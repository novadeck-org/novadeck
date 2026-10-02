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
 * aside: the first and last rows of each place it appears, and the index in its first row
 * where it starts.
 */
export const findLine = (
  rows: readonly string[],
  line: string,
): readonly { readonly first: number; readonly last: number; readonly column: number }[] => {
  const needle = compact(line)
  if (!needle) return []
  let joined = ""
  const at: { row: number; column: number }[] = []
  for (const [row, text] of rows.entries())
    for (let column = 0; column < text.length; column += 1) {
      if (/\s/.test(text[column]!)) continue
      joined += text[column]
      at.push({ row, column })
    }
  const found: { first: number; last: number; column: number }[] = []
  for (let start = joined.indexOf(needle); start >= 0; start = joined.indexOf(needle, start + 1))
    found.push({
      first: at[start]!.row,
      last: at[start + needle.length - 1]!.row,
      column: at[start]!.column,
    })
  return found
}

/** Whether two rows read the same, trailing blanks aside. */
const same = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? "").trimEnd() === (b ?? "").trimEnd()

/** Whether a row shows nothing. */
const blank = (row: string | undefined): boolean => (row ?? "").trim() === ""

/** Whether a row shows only text it showed before, where it was: some of it erased. */
const erased = (row: string, was: string | undefined): boolean => {
  const kept = [...(was ?? "")]
  return [...row].every((char, index) => /\s/.test(char) || char === kept[index])
}

/** What a test paste showed: accepted, with the rows the line took; or why not. */
export type PasteCheck =
  | { readonly accepted: true; readonly first: number; readonly last: number }
  | { readonly accepted: false; readonly reason: "absent" | "repeated" | "before" | "elsewhere" }

/**
 * Whether a test paste landed where Enter would submit it alone: the line appears on the
 * screen exactly once, and didn't before, and every row that changed is one it takes or
 * within `nearRows` of them. Where the box grew a row, the rows above it may have moved
 * up one and those below down one; they are compared moved.
 *
 * Failing that, and only where `vanish` allows it, as for a ring of a Ready terminal
 * (before its session's first turn, its box known empty), it is still accepted where the
 * line replaced the box's empty state and, away from it, one isolated block of text vanished whole, as a TUI may draw something
 * only while its box is empty (Codex its logo). For one of the same moves: before the
 * paste, the line's row showed what now precedes the line, which is not nothing, and more
 * (a placeholder, where text the line was appended to shows no more); every far row is
 * the one it came from, or blank; the rows that went blank are one contiguous block, with
 * blank rows or the screen's edge on both sides of it before; and no near row shows
 * anything it didn't, each the one it came from or with some of its text erased in place
 * (Codex's footer hint). A list filtered down to some of its items keeps text beside the
 * block, or leaves several; a footer moved up shows text a near row didn't.
 */
export const checkPaste = (
  before: readonly string[],
  after: readonly string[],
  line: string,
  { vanish = false }: { readonly vanish?: boolean } = {},
): PasteCheck => {
  if (findLine(before, line).length > 0) return { accepted: false, reason: "before" }
  const found = findLine(after, line)
  if (found.length === 0) return { accepted: false, reason: "absent" }
  if (found.length > 1) return { accepted: false, reason: "repeated" }
  const { first, last, column } = found[0]!
  if (before.length !== after.length) return { accepted: false, reason: "elsewhere" }
  const accepted = { accepted: true, first, last } as const
  // The row of `before` a far row of `after` came from, the box having grown `up` or
  // `down`; undefined for a row near the line.
  const origin = (index: number, up: number, down: number): number | undefined => {
    if (index < first - nearRows) return index + up
    if (index > last + nearRows) return index - down
    return undefined
  }
  const moves = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const
  const unchanged = (up: number, down: number) =>
    after.every((row, index) => {
      const from = origin(index, up, down)
      return from === undefined || same(row, before[from])
    })
  if (moves.some(([up, down]) => unchanged(up, down))) return accepted
  if (!vanish) return { accepted: false, reason: "elsewhere" }
  // What precedes the line on its row: the box's prompt, or text it was appended to.
  const lead = compact(after[first]!.slice(0, column))
  const emptied = (up: number, down: number): boolean => {
    if (!lead) return false
    const shown = compact(before[first + up] ?? "")
    if (!shown.startsWith(lead) || shown.length <= lead.length) return false
    const gone: number[] = []
    for (const [index, row] of after.entries()) {
      if (index >= first && index <= last) continue
      const from = index < first ? index + up : index - down
      if (same(row, before[from])) continue
      const far = origin(index, up, down) !== undefined
      if (far && blank(row)) gone.push(from)
      else if (far || !erased(row, before[from])) return false
    }
    if (gone.length === 0) return false
    const [top, bottom] = [gone[0]!, gone.at(-1)!]
    return bottom - top === gone.length - 1 && blank(before[top - 1]) && blank(before[bottom + 1])
  }
  return moves.some(([up, down]) => emptied(up, down))
    ? accepted
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
