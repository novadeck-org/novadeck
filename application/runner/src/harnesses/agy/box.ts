import { agreeing, rule, ruledBox, type BoxProfile, type Markers } from "@novadeck/harness-core/box"
import type { ScreenText } from "@novadeck/harness-core/screen"

/** The markers leading its box's first row: `>` as a prompt, `!` in its shell mode. */
const markers: Markers = { prompt: ">", shell: "!" }

/**
 * Whether its footer says the box is in its shell mode (`!`), where Enter runs what it
 * holds as a command: its last row says so, "activated bash mode · esc to cancel" (probed 1.2.14 and 1.3.0, fixtures/shell-mode.probe.json).
 */
export const shellFooter = (rows: readonly string[]): boolean => {
  const last = rows.findLast((row) => row.trim() !== "")
  return last !== undefined && /^activated bash mode(\s|·|$)/.test(last.trim())
}

/**
 * On Windows its shell mode runs a command in cmd (probed 2026-10-10, 1.2.14), which runs
 * only its first line: the lines are joined with `&`, which runs each after the one before
 * whatever that returned, as sh runs lines. A blank line joins nothing. Undefined for one
 * whose lines can't be joined so and mean the same: a remark (`rem`, `@rem`, `rem.`, one
 * after an `&` mid-line or as what `if`, `else` or `do` runs, or behind the `;`, `,`, `=`
 * and spaces cmd skips) or a label (`:x`, `::`, at a line's start or after an `&`) would
 * swallow every line after it, a `%` be expanded across the whole joined line before any
 * of it runs (`set N=1` then `echo %N%`, `%ERRORLEVEL%`), an odd `"` quote the joining
 * `&`, a trailing `^` escape it, a block (`if x (` … `)`) or a line ending or starting in
 * `&`, `&&`, `|` or `||` become a syntax error, and a continued line's indent be lost.
 * `if` refuses a `rem` anywhere after it, its argument as well as its body: refusing
 * asks for one line, which runs as written.
 */
export const shellCommandOf = (
  command: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  if (platform !== "win32") return command
  const lines = command.split("\n").filter((line) => line.trim() !== "")
  if (lines.length < 2) return command.trim()
  const unjoinable = lines.some((line, at) => {
    const text = line.trim()
    return (
      /(^|[&|(])[\s;,=@]*(rem(\W|$)|:)/i.test(text) ||
      /\b(else|do)[\s;,=@]+rem(\W|$)/i.test(text) ||
      /(^|[&|(])[\s;,=@]*if\b.*[\s;,=@]rem(\W|$)/i.test(text) ||
      text.includes("%") ||
      // A `^"` is a quote cmd prints, which opens nothing.
      (text.replaceAll('^"', "").match(/"/g) ?? []).length % 2 === 1 ||
      /[\^(&|]$/.test(text) ||
      /^[)&|]/.test(text) ||
      (at > 0 && lines[at - 1]!.trimEnd().endsWith("^"))
    )
  })
  return unjoinable ? undefined : lines.map((line) => line.trim()).join(" & ")
}

// Its word under a turn the person's Escape stopped (probed 2026-10-02, 1.2.14), white
// space aside, as a narrow screen wraps it.
const interruption = "⎿Interrupted·WhatshouldAntigravityCLIdoinstead?"

/**
 * Whether the rows last above its box's top rule, blank rows aside, end in its word that
 * the person's Escape stopped the turn, which it draws under a reply it kept as well: on
 * Windows a reply let go 2 to 5 ms after the key showed with it, the transcript and the
 * next model call holding the reply as where it showed alone, and no Stop came for
 * either (probed 2026-10-10, 1.2.14). The word may wrap over a few rows. Undefined where
 * no box is found to read above, as mid-redraw or under a dialog: no telling then.
 */
export const interruptedShown = (screen: ScreenText): boolean | undefined => {
  const box = ruledBox(screen, markers)
  if (!box) return undefined
  const top = screen.rows.slice(0, box.first).findLastIndex(rule)
  if (top < 0) return undefined
  const above = screen.rows.slice(0, top)
  const last = above.findLastIndex((row) => row.trim() !== "")
  // The rows the word may span, without the white space a wrap leaves.
  const tail = above
    .slice(Math.max(0, last - 3), last + 1)
    .join("")
    .replaceAll(/\s+/g, "")
  return tail.endsWith(interruption)
}

/**
 * Antigravity's input box: between two `─` rules, `> ` leading its first row and the rest
 * indented (probed 1.2.14 and 1.3.1, fixtures/input-box.probe.json). Its history above
 * echoes the person's turns the same way, rules and all, so only the lowest pair is the
 * box. A paste of more than 15 lines shows as `[Pasted text #1 +40 lines]`, a long line as
 * `[Pasted text #4 1499 chars]`.
 */
export const box: BoxProfile = {
  read: (screen) => agreeing(ruledBox(screen, markers), shellFooter(screen.rows)),
  // Enter would run a command shown as a placeholder as the placeholder's own text.
  shell: { expands: false, starts: true, footer: shellFooter, command: shellCommandOf },
  collapsed: ({ text }) => /^\[Pasted text #\d+ (?:\+\d+ lines?|\d+ chars?)\]$/.test(text.trim()),
  // 15 lines showed whole, even of 100 characters each; 16 did not. One line of 1,000
  // characters showed whole, 1,024 did not.
  // Ctrl-U clears the line the cursor is on and Backspace joins the line before it; the
  // queued messages an Escape put back are one to a line (probed 2026-10-07).
  clear: ({ first, last }) => `${"\x15\x7f".repeat(last - first)}\x15`,
  interrupted: interruptedShown,
  queued: (screen) => screen.rows.some((row) => row.includes("Press up to edit queued messages")),
  collapses: (text) => text.split("\n").length > 15 || (!text.includes("\n") && text.length > 1024),
  room: (rows) => rows - 4,
}
