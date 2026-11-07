import type { ScreenText } from "@novadeck/emulator/headless"
import type { SliceProfile } from "@novadeck/harness-core/slices"
import {
  agreeing,
  eraseRows,
  footerRows,
  leaveShell,
  rule,
  ruledBox,
  type BoxProfile,
  type InputBox,
  type Markers,
} from "@novadeck/tui-input/box"

/** The markers leading its box's first row: `>` as a prompt, `!` in its shell mode. */
const markers: Markers = { prompt: ">", shell: "!" }

/**
 * Whether its footer says the box is in its shell mode (`!`), where Enter runs what it
 * holds as a command: its last row says so, "activated bash mode · esc to cancel" (probed
 * 1.2.14 and 1.3.0, fixtures/shell-mode.probe.json).
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

/**
 * Where it draws its panel of running subagents, between rules under its box, a row each
 * (`  ● Agent(self: Helper)  Working · 3s`; probed 2026-10-19, 1.2.14,
 * fixtures/background-prompt.probe.json): the rows from the panel's first to its closing
 * rule, the box's own closing rule above them. Undefined where the lowest ruled region
 * holds anything else.
 */
const panelOf = (rows: readonly string[]): { first: number; last: number } | undefined => {
  const bottom = rows.findLastIndex(rule)
  const top = rows.slice(0, bottom).findLastIndex(rule)
  if (top < 0) return undefined
  const inside = rows.slice(top + 1, bottom).filter((row) => row.trim() !== "")
  return inside.length > 0 && inside.every((row) => /^\s*● Agent\(/.test(row))
    ? { first: top + 1, last: bottom }
    : undefined
}

/**
 * The screen as its box is read off it, the panel of running subagents under the box set
 * aside: there, the lowest pair of rules is the panel's. Only one below the cursor.
 */
const withoutPanel = (screen: ScreenText): ScreenText => {
  const panel = panelOf(screen.rows)
  if (!panel || screen.cursor.row >= panel.first - 1) return screen
  const unruled = (rows: readonly string[]) =>
    rows.map((row, at) => (at >= panel.first && at <= panel.last ? "" : row))
  return { ...screen, rows: unruled(screen.rows), bright: unruled(screen.bright) }
}

/**
 * The rows as the calm and a paste's check read them, without the panel of running
 * subagents: it redraws their elapsed time with whatever else it draws, as a paste lands,
 * and pushes the footer, whose hint a paste erases, further from the box than a paste's
 * reach (`nearRows`).
 */
const still = (rows: readonly string[]): readonly string[] => {
  const panel = panelOf(rows)
  return panel ? rows.filter((_, at) => at < panel.first || at > panel.last) : rows
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
const interruptedShown = (screen: ScreenText): boolean | undefined => {
  const box = ruledBox(withoutPanel(screen), markers)
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
 * Whether it shows a panel under its box (the shortcuts `?` opens, the artifacts Ctrl-R
 * opens), each with a "Keyboard: … esc Close|Dismiss" row and its empty box above (probed
 * 1.2.14 in the e2e sandbox, 2026-10-16). Read under the box, where one reads: a line or a draft
 * in it may say those words at a row's start (1.5.2, 2026-11-07, fixtures/ring-reading.probe.json).
 */
const overlay = (screen: ScreenText): boolean => {
  const shown = read(screen)
  const under = shown ? screen.rows.slice(shown.last + 1) : footerRows(screen)
  return under.some((row) => /^Keyboard: .*\besc (Close|Dismiss)\b/.test(row.trim()))
}

/** The rows that say a box shows only part of its text, whatever words a version has for it. */
const rowAbove = /^↑[^\n]*(?:\n|$)/
const rowBelow = /(?:^|\n)↓[^\n]*$/

/**
 * Its box, with the rows that say it shows only a part in its text however they are drawn: a
 * text is read off its bright cells, and a box that holds more than it shows, taken for all of
 * it, loses the rest. From 1.5 a text taller than the box has an `↑ 21 more lines` row over it
 * and, with the cursor moved up, an `↓ 14 more lines` row under it (probed 2026-11-06, 1.5.2, the
 * `tall` states of fixtures/leftover.probe.json).
 */
const marked = (box: InputBox | undefined, screen: ScreenText): InputBox | undefined => {
  if (!box) return box
  const top = screen.rows[box.first]?.slice(markers.prompt.length).trim() ?? ""
  const bottom = screen.rows[box.last]?.trim() ?? ""
  const rows = box.text.split("\n")
  if (top.startsWith("↑")) rows[0] = top
  if (bottom.startsWith("↓")) rows[box.last - box.first] = bottom
  return { ...box, text: rows.join("\n") }
}

/** How its box reads off a screen. */
const read = (screen: ScreenText): InputBox | undefined =>
  marked(agreeing(ruledBox(withoutPanel(screen), markers), shellFooter(screen.rows)), screen)

/**
 * Antigravity's input box: between two `─` rules, `> ` leading its first row and the rest
 * indented (probed 1.2.14 and 1.3.1, fixtures/input-box.probe.json). Its history above
 * echoes the person's turns the same way, rules and all, so only the lowest pair is the
 * box, once a panel of running subagents under it is set aside. A paste of more than 15
 * lines shows as `[Pasted text #1 +40 lines]`, a long line as
 * `[Pasted text #4 1499 chars]`. It leaves a ZWJ family sequence blank (probed), so the
 * library compares text without such emoji.
 */
export const box: BoxProfile = {
  read,
  // Enter would run a command shown as a placeholder as the placeholder's own text (probed
  // 2026-10-07). A `!` command creates the conversation and binds the session (`starts`;
  // probed 2026-10-08).
  shell: {
    expands: false,
    starts: true,
    footer: shellFooter,
    command: shellCommandOf,
    leave: leaveShell,
  },
  // On 80 and 120 columns a word reaches 76 and 116; one too long for a row starts a new row
  // and breaks a column further (fixtures/leftover.probe.json).
  textWidth: (columns) => columns - 4,
  stands: (text) => /\[(?:Pasted text #\d+|Image\b)/.test(text),
  collapsed: ({ text }) => /^\[Pasted text #\d+ (?:\+\d+ lines?|\d+ chars?)\]$/.test(text.trim()),
  // A text taller than its box scrolls under a row saying how much, which reads as part of
  // the text: 30 queued lines on 40 rows came back as `↑ 10 more lines` and the last 20, and
  // scrolled up the row stands last, as `↓` (probed 2026-11-06, 1.5.2).
  cut: ({ text }) => rowAbove.test(text) || rowBelow.test(text),
  uncut: (text) => text.replace(rowAbove, "").replace(rowBelow, ""),
  // 15 lines showed whole, even of 100 characters each; 16 did not. One line of 1,000
  // characters showed whole, 1,024 did not.
  // Ctrl-U clears the line the cursor is on and Backspace joins the line before it; the
  // queued messages an Escape put back are one to a line (probed 2026-10-07).
  clear: eraseRows,
  erase: eraseRows,
  // It draws the cursor on the last cell of the text, not the one after it (fixtures/leftover.probe.json).
  caret: 1,
  overlay,
  interrupted: interruptedShown,
  queued: (screen) => screen.rows.some((row) => row.includes("Press up to edit queued messages")),
  collapses: (text) => text.split("\n").length > 15 || (!text.includes("\n") && text.length > 1024),
  room: (rows) => rows - 4,
  still,
}

/**
 * Where it draws its own: `/` and `@` under the box on the normal screen, which scrolls up to
 * make room, and a view under the box as well, which stays, empty; one too tall for the rows
 * left goes to the alternate screen. `$` is plain text (probed 1.4.12 and 1.5.2,
 * fixtures/live-slice.probe.json). No prompt for a secret was reached: a session under an
 * API key has no login.
 */
export const slice: SliceProfile = {
  agent: "agy",
  side: () => "below",
  viewsUnder: true,
  secret: () => false,
}
