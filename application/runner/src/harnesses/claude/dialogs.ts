import { posix, win32 } from "node:path"

import type { RequestAnswer } from "@novadeck/protocol"

import type { DialogAdapter, DialogRead, KeyStep, ReadDialog, RequestFacts } from "../dialogs.js"
import { elicitationTool } from "./decode.js"

/**
 * Claude Code's dialogs as the person sees them in its TUI: a permission, an
 * AskUserQuestion, an ExitPlanMode. Read from the screen in full and checked against what
 * the hook said the request asks (the command, the file, the questions and their options,
 * the plan's file); anything else, or anything an update changed, reads as undefined.
 *
 * Probed on 2026-10-06 (2.1.287, `fixtures/ask.probe.json`, 120x40 and 60x20):
 * - A permission's options number from 1 and a digit answers at once, whatever the
 *   highlight; their count varies with the width (an MCP tool's second option goes at 60
 *   columns), so the digits come from the screen.
 * - A question's digit selects its option and, with several questions, moves to the next
 *   tab; a multi-select's digits toggle and Right moves on; after the last question a
 *   review screen takes `1` to submit. "Type something" is the option after the last,
 *   whose digit focuses a field that takes the text and Enter once the screen shows it
 *   focused. With any option previewed, digits only move the highlight: Down and Enter.
 * - ExitPlanMode's "Ready to code?" takes `1` or `2` at once; `3` opens a field for the
 *   feedback.
 */

const Right = "\x1b[C"
const Down = "\x1b[B"
const Up = "\x1b[A"
const Enter = "\r"
const timeoutMs = 3000

/** Text without whitespace and the quote bars, so that wrapping never matters. */
const flat = (text: string): string => text.replace(/[\s│]+/g, "")

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "")

const rule = /^─+$/
const dashed = /^╌+$/

const last = <T>(items: readonly T[], test: (item: T, index: number) => boolean): number => {
  for (let index = items.length - 1; index >= 0; index--) {
    if (test(items[index]!, index)) return index
  }
  return -1
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

// Words the person types into a field: one line, as the field takes them.
// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
const typeable = (text: string): boolean => !/[\x00-\x1f\x7f]/.test(text)

/**
 * Whether row `n`, highlighted, now starts with `text` (as far as a row shows it): the
 * field's own row, where words typed into it appear, and no other row.
 */
const landed = (
  rows: readonly string[],
  row: RegExp,
  n: number,
  text: string,
  tick = "",
): boolean => {
  const start = text.trimStart().slice(0, 20)
  return rows.some((each) => {
    const match = row.exec(each)
    return (
      match?.[1] === "❯" &&
      Number(match[2]) === n &&
      match[3]!.startsWith(tick) &&
      match[3]!.slice(tick.length).startsWith(start)
    )
  })
}

const digit = (n: number): string | undefined => (n >= 1 && n <= 9 ? String(n) : undefined)

// ---------------------------------------------------------------------------------------
// Permissions

/**
 * Whether Claude Code's own input box shows, between its rules above the status row: it
 * hides while a dialog is up, so it back is the positive sign a dialog is gone.
 */
const idle = (rows: readonly string[]): boolean =>
  rows.some((each, at) => {
    if (!each.startsWith("❯") || at === 0) return false
    const before = last(rows.slice(0, at), (row) => row !== "")
    const after = rows.findIndex((row, index) => index > at && row !== "")
    return before >= 0 && rule.test(rows[before]!) && after >= 0 && rule.test(rows[after]!)
  })

type Option = { readonly n: number; readonly marker: boolean; readonly label: string }

/**
 * Numbered option rows from `from` on, each with its wrapped continuation rows, in the
 * layout `row` reads; what follows them is returned as `rest`. Undefined unless they
 * number 1, 2, … and exactly one is highlighted.
 */
const numbered = (
  rows: readonly string[],
  from: number,
  row: RegExp,
  continuation: RegExp,
  hint?: RegExp,
): { options: Option[]; rest: string[] } | undefined => {
  const options: { n: number; marker: boolean; label: string }[] = []
  let index = from
  for (; index < rows.length; index++) {
    const text = rows[index]!
    // The screen leaves blank rows between a dialog's parts.
    if (text === "") continue
    const match = row.exec(text)
    if (match) {
      options.push({ n: Number(match[2]), marker: match[1] === "❯", label: match[3]!.trim() })
    } else if (options.length > 0 && continuation.test(text)) {
      const each = options[options.length - 1]!
      each.label = `${each.label} ${text.trim()}`
    } else if (options.length > 0 && hint?.test(text)) {
      continue
    } else break
  }
  const rest = rows.slice(index).filter((each) => each !== "")
  const marked = options.filter(({ marker }) => marker).length
  if (options.length < 2 || marked !== 1) return undefined
  if (options.some(({ n }, at) => n !== at + 1)) return undefined
  return { options, rest }
}

const choices = (
  title: string,
  detail: string | null,
  options: readonly Option[],
  keys: (
    option: Option,
    answer: RequestAnswer & { type: "choice" },
  ) => readonly KeyStep[] | undefined,
  answered: (rows: readonly string[]) => boolean,
  field?: number,
  // Options whose words go as the next prompt, once the option is chosen; and options the
  // screen doesn't have, which press one it does.
  prompts: ReadonlySet<number> = new Set(),
  emulated: readonly { id: string; label: string; presses: number }[] = [],
): DialogRead => {
  const dialog: ReadDialog = {
    type: "choices",
    title,
    detail,
    options: [
      ...options.map(({ n, label }) => ({
        id: String(n),
        label,
        text: n === field ? ("field" as const) : prompts.has(n) ? ("prompt" as const) : null,
      })),
      ...emulated.map(({ id, label }) => ({ id, label, text: "prompt" as const })),
    ],
  }
  return {
    dialog,
    keys: (answer) => {
      if (answer.type !== "choice") return undefined
      const copy = emulated.find(({ id }) => id === answer.option)
      const option = options.find(({ n }) => n === (copy ? copy.presses : Number(answer.option)))
      // The words of a prompt option are the driver's to send afterwards.
      if (copy) return option ? keys(option, { ...answer, text: undefined }) : undefined
      if (!option || String(option.n) !== answer.option) return undefined
      return keys(option, prompts.has(option.n) ? { ...answer, text: undefined } : answer)
    },
    answered,
  }
}

// The row each permission's dialog asks its question on.
const permissionTitle = /^ (Do you want to .+\?)$/
const permissionOption = /^ (❯| ) (\d+)\. (.+)$/
const permissionContinuation = /^ {6,}\S/
const permissionFooter = /^ Esc to cancel · Tab to amend$/

/** Rows' text as the dialog quotes it: without the quote bar a command's rows carry. */
const quoted = (rows: readonly string[]): string[] =>
  rows.filter((each) => each !== "").map((each) => each.replace(/^ ?(?:│ )?/, "").trimEnd())

/**
 * Whether `rows` are `expected` as the terminal wrapped it: whitespace collapsed (never
 * stripped), a row break standing for a space where the text has one and for none where
 * it broke a word.
 */
const wraps = (rows: readonly string[], expected: string): boolean => {
  const want = expected.trim()
  let at = 0
  for (const row of rows.map((each) => each.trim()).filter((each) => each !== "")) {
    if (!want.startsWith(row, at)) return false
    at += row.length
    // A row ends where the terminal wrapped it (at a space, which it drops, or inside a
    // word) or where the text has a line break; whitespace inside a row is the text's.
    at += /^(?: |[ \t]*\n\s*)/.exec(want.slice(at))?.[0].length ?? 0
  }
  return want !== "" && at >= want.length
}

/** The ╌-ruled block above `from`, with the rows above it. */
const ruled = (
  rows: readonly string[],
  from: number,
): { above: readonly string[]; body: readonly string[]; open: number } | undefined => {
  const close = last(rows.slice(0, from), (each) => dashed.test(each))
  if (close < 1) return undefined
  const open = last(rows.slice(0, close), (each) => dashed.test(each))
  if (open < 1) return undefined
  return { above: rows.slice(0, open), body: rows.slice(open + 1, close), open }
}

// The folder Claude Code runs in, where the request tells it.
const cwdOf = ({ cwd }: RequestFacts): string | null =>
  typeof cwd === "string" && cwd !== "" ? cwd.replaceAll("\\", "/") : null

/**
 * Whether the file the dialog names is the request's: a shown path is relative to the
 * folder Claude Code runs in, so with that known the full paths must be the same; without
 * it, the request's path must end with the shown one at a folder boundary.
 */
// A path with a drive letter is Windows', resolved and compared as Windows does (either
// slash, any case), whatever the runner's own platform; any other as POSIX.
const windows = (value: string): boolean => /^[A-Za-z]:[\\/]/.test(value)
const comparable = (value: string): string =>
  win32.normalize(value).replaceAll("\\", "/").toLowerCase()

const samePath = (path: string, shown: string, cwd: string | null): boolean => {
  if (windows(path) || windows(shown) || (cwd !== null && windows(cwd))) {
    if (windows(shown)) return comparable(path) === comparable(shown)
    if (cwd !== null) return comparable(path) === comparable(win32.resolve(cwd, shown))
    return comparable(path).endsWith(`/${comparable(shown)}`)
  }
  if (shown.startsWith("/")) return posix.normalize(path) === posix.normalize(shown)
  if (cwd !== null) return posix.normalize(path) === posix.resolve(cwd, shown)
  return path === shown || path.endsWith(`/${shown}`)
}

// Claude Code draws each tab that leads a line as two spaces in a diff, and as eight in the
// text of a new file (probed 2.1.287 and 2.1.291).
const drawn = (text: string, width = 2): string =>
  text
    .split("\n")
    .map((line) => {
      let tabs = 0
      while (line[tabs] === "\t") tabs++
      return tabs === 0 ? line : " ".repeat(width * tabs) + line.slice(tabs)
    })
    .join("\n")

// The longest text of an edit or a write that is read: a diff of more cannot show on screen.
const longest = 65_536

// The lines of a text written to a file, as its diff draws them: only where each can be told
// apart from other text that draws the same, so with a break ending the last line, none ending
// in blanks, and every blank line one of its own.
const contentLines = (value: unknown, width = 2): string[] | undefined => {
  if (typeof value !== "string" || value.length > longest || !value.endsWith("\n")) return undefined
  if (blanksBeforeBreak(value)) return undefined
  const lines = drawn(value, width).split("\n")
  lines.pop()
  return lines
}

type DiffLine = {
  readonly marker: string
  readonly number: number
  readonly pieces: string[]
  // Whether each piece's row filled the screen's width: only then may a word break inside it.
  readonly full: boolean[]
}

/**
 * Whether the pieces of a line, as the terminal wrapped them (at a space it drops, or in
 * the middle of a word), are `expected`.
 */
const joined = (pieces: readonly string[], expected: string, full: readonly boolean[]): boolean => {
  let at = 0
  for (const [index, piece] of pieces.entries()) {
    if (!expected.startsWith(piece, at)) return false
    at += piece.length
    if (index === pieces.length - 1) break
    // Ink wraps at a space, which it drops; inside a word only where a row is full.
    if (expected[at] === " ") at++
    else if (!full[index]) return false
  }
  // A space left at the end is a wrap's own, not the line's.
  return at >= expected.length || expected.slice(at).trim() === ""
}

const matches = (shown: readonly DiffLine[], expected: readonly string[]): boolean =>
  shown.length === expected.length &&
  shown.every((line, at) => joined(line.pieces, expected[at]!, line.full))

const single = (row: DiffLine): string | undefined =>
  row.pieces.length === 1 ? row.pieces[0] : undefined

// Whether a line of the text ends in blanks before its line break, which Claude Code does not draw.
const blanksBeforeBreak = (text: string): boolean => {
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
    if (at > 0 && (text[at - 1] === " " || text[at - 1] === "\t")) return true
  }
  return false
}

const texts = (row: DiffLine): string[] =>
  row.pieces.length === 1 ? [row.pieces[0]!] : [row.pieces.join(""), row.pieces.join(" ")]

const same = (a: readonly DiffLine[], b: readonly DiffLine[]): boolean =>
  a.length === b.length && a.every((row, at) => row === b[at])

/**
 * Whether the drawn diff is exactly this replacement of `from` by `to` and no other.
 * Claude Code draws the whole file before and after, each line a row: what the edit
 * leaves alone is context, shared by both sides, and a changed line shows whole, removed
 * and added again. So the lines `from` and `to` share at their start and end are context
 * and the rest are the changed rows, which must start and end exactly where the text's
 * differing lines do, with only context before them and after: the replacement can be at
 * one place and no other. Within that, each side's rows are the text with the other's
 * put in: the first row's start and the last row's end are what the text leaves of them.
 */
const placed = (
  oldSide: readonly DiffLine[],
  newSide: readonly DiffLine[],
  from: string,
  to: string,
  raw: boolean,
): boolean => {
  if (from.trim() === "") return false
  // Claude Code draws the tabs that lead a line as spaces. Every line of the text after the
  // first starts a line; the first starts one only if nothing but blanks stand before it.
  const tabLead = from.startsWith("\t") || to.startsWith("\t")
  if (raw && !tabLead) return false
  const lines = (text: string) =>
    text.split("\n").map((line, at) => (at === 0 && raw ? line : drawn(line)))
  const O = lines(from)
  const N = lines(to)
  const shared = Math.min(O.length, N.length)
  const removed = oldSide.flatMap((row, at) => (row.marker === "-" ? [at] : []))
  const added = newSide.flatMap((row, at) => (row.marker === "+" ? [at] : []))
  const attempt = (head: number, foot: number): boolean => {
    const outer = O.length - head - foot
    const inner = N.length - head - foot
    if (outer < 0 || inner < 0 || (outer === 0 && inner === 0)) return false
    if ((outer === 0) !== (removed.length === 0) || (inner === 0) !== (added.length === 0))
      return false
    const a = (removed.length > 0 ? removed[0]! : added[0]!) - head
    const b = a + O.length - 1
    const c = a + N.length - 1
    if (a < 0 || b >= oldSide.length || c >= newSide.length) return false
    // Only context before and after, and the same context in both sides.
    if (!same(oldSide.slice(0, a), newSide.slice(0, a))) return false
    if (!same(oldSide.slice(b + 1), newSide.slice(c + 1))) return false
    // The changed rows begin and end where the differing lines do.
    if (outer > 0 && (removed[0] !== a + head || removed.at(-1) !== b - foot)) return false
    if (inner > 0 && (added[0] !== a + head || added.at(-1) !== c - foot)) return false
    const first = oldSide[a]!
    const closing = oldSide[b]!
    // What the text leaves of the first and the last row, so that the new rows are what its
    // replacement makes of them; a row that wrapped counts only whole.
    const tried = (prefix: string, suffix: string): boolean => {
      // A tab that begins the text leads the line only after blanks; a tab left as it is must
      // show as one in the rows.
      if (tabLead && !raw && !/^ *$/.test(prefix)) return false
      const wrote = (prefix + N.join("\n") + suffix).split("\n")
      return wrote.every((line, at) => {
        const row = newSide[a + at]!
        const only = single(row)
        return only === undefined ? joined(row.pieces, line, row.full) : only === line.trimEnd()
      })
    }
    const text = (row: DiffLine): string | undefined => single(row)
    for (let at = 0; at < O.length; at++) {
      const row = oldSide[a + at]!
      const line = O[at]!
      const only = text(row)
      if (only === undefined) {
        if (!joined(row.pieces, line, row.full)) return false
      } else if (O.length === 1) {
        // The row holds the whole of the text, somewhere.
        for (let i = only.indexOf(line); i >= 0; i = only.indexOf(line, i + 1)) {
          if (tried(only.slice(0, i), only.slice(i + line.length))) return true
        }
        return false
      } else if (
        at === 0
          ? !only.endsWith(line)
          : at === O.length - 1
            ? !only.startsWith(line)
            : only !== line
      ) {
        return false
      }
    }
    if (O.length === 1) return tried("", "")
    const lead = single(first)
    const tail = single(closing)
    return tried(
      lead === undefined ? "" : lead.slice(0, lead.length - O[0]!.length),
      tail === undefined ? "" : tail.slice(O[O.length - 1]!.length),
    )
  }
  let head = 0
  while (head < shared && O[head] === N[head]) head++
  let foot = 0
  while (foot < shared && O[O.length - 1 - foot] === N[N.length - 1 - foot]) foot++
  // Where lines repeat the two overlap, and the diff may draw it either way.
  return (
    attempt(head, Math.min(foot, shared - head)) || attempt(Math.min(head, shared - foot), foot)
  )
}

/**
 * Whether the drawn diff is exactly the edit: `old_string` replaced by `new_string` at one
 * place (see `placed`). Leading tabs are drawn as spaces, and blanks before a line break
 * are never drawn, so a text with them is not read; at the end of the text they are. An
 * old text of only blanks is not read. Not read either: a replacement by nothing of a text
 * that does not end a line (Claude Code takes the line's break with it, and draws a blank
 * row), a screen such a replacement could have drawn, and a change that may reach the end of
 * the file (fewer than three rows of context after it, or a "No newline at end of file" row).
 */
const editIs = (lines: readonly DiffLine[], old: unknown, fresh: unknown): boolean => {
  if (typeof old !== "string" || typeof fresh !== "string" || old === fresh) return false
  if (old.length > longest || fresh.length > longest) return false
  if (blanksBeforeBreak(old) || blanksBeforeBreak(fresh)) return false
  // Claude Code's edit also removes the line break after a text it replaces by nothing, but
  // its dialog draws a plain replacement: only a whole line, break and all, is unambiguous.
  if (fresh === "" && !old.endsWith("\n")) return false
  const changed = lines.flatMap(({ marker }, at) => (marker !== " " ? [at] : []))
  if (changed.length === 0) return false
  // Three lines of context follow the change unless the file ends there: where it might,
  // the end of the file (and whether its last line is ended) is not something to vouch for.
  if (lines.length - 1 - changed.at(-1)! < 3) return false
  // Lines removed and none added: how a text that begins with a line break, replaced by
  // nothing, is drawn, as well as a whole line removed; and a blank row alone added is how a
  // line's text replaced by nothing is drawn. One added row that is the start of the first
  // removed row, however that wrapped, is drawn the same.
  const goneRows = lines.filter(({ marker }) => marker === "-")
  const put = lines.filter(({ marker }) => marker === "+")
  if (goneRows.length > 0 && put.length === 0) return false
  if (put.length === 1) {
    const added = texts(put[0]!)
    if (added.some((each) => each.trim() === "")) return false
    if (goneRows.length > 0) {
      const first = texts(goneRows[0]!)
      if (first.some((line) => added.some((each) => line.startsWith(each)))) return false
    }
  }
  const oldSide = lines.filter(({ marker }) => marker !== "+")
  const newSide = lines.filter(({ marker }) => marker !== "-")
  for (const raw of [false, true]) {
    if (placed(oldSide, newSide, old, fresh, raw)) return true
  }
  return false
}

/**
 * Whether the diff block is the input's. Its rows are numbered, each with a marker column
 * (` `, `-`, `+`) and the line, as an edit or an overwrite shows them; a new file has no
 * marker column. A line longer than the screen wraps onto rows without a number. An edit's
 * drawn old text with `new_string` put where `old_string` stands must be its drawn new
 * text exactly (see `editIs`); an overwrite's new text is `content`, whole; a new file's lines are `content`,
 * numbered from 1. The block's top is on screen: where a tall diff scrolls it away nothing
 * binds the file, and it is not read.
 */
const diffIs = (
  body: readonly string[],
  tool: string,
  over: boolean,
  input: Record<string, unknown>,
  cols: number,
): boolean => {
  const marked = tool === "Edit" || over
  const lines: DiffLine[] = []
  const rows = body.filter((each) => each.trim() !== "")
  // Whether the file ends in a line break is drawn as a row of its own: not vouched for.
  if (rows.some((row) => /No newline at end of file\s*$/.test(row))) return false
  // The line numbers are right-aligned: every numbered row's number ends in one column,
  // so a wrapped row that merely begins with digits is told from one.
  const numberOf = (row: string) => {
    const match = marked
      ? /^(\s*)(\d+) ([ +-])(.*)$|^(\s*)(\d+)$/.exec(row)
      : /^(\s*)(\d+)(?: (.*))?$/.exec(row)
    if (!match) return undefined
    const lead = marked ? (match[1] ?? match[5]!) : match[1]!
    const digits = marked ? (match[2] ?? match[6]!) : match[2]!
    return {
      end: lead.length + digits.length,
      number: Number(digits),
      marker: marked ? (match[3] ?? " ") : " ",
      text: marked ? (match[4] ?? "") : (match[3] ?? ""),
    }
  }
  const end = Math.min(...rows.map((row) => numberOf(row)?.end ?? Infinity))
  for (const row of rows) {
    const first = numberOf(row)
    // For a new file a number is a line's own only where it follows the one before.
    const follows =
      marked ||
      (lines.length === 0 ? first?.number === 1 : first?.number === lines.at(-1)!.number + 1)
    if (first && first.end === end && follows) {
      lines.push({
        marker: first.marker,
        number: first.number,
        pieces: [first.text.trimEnd()],
        full: [row.length === cols],
      })
      continue
    }
    // A row without a number goes on the line before.
    const more = marked ? /^\s+([ +-])(.*)$/.exec(row) : /^\s+(.*)$/.exec(row)
    const text = marked ? more?.[2] : more?.[1]
    const before = lines.at(-1)
    if (!more || text === undefined || !before) return false
    before.pieces.push(text.trimEnd())
    before.full.push(row.length === cols)
  }
  if (!marked) {
    const content = contentLines(input.content, 8)
    return (
      content !== undefined &&
      matches(lines, content) &&
      lines.every(({ number }, at) => number === at + 1)
    )
  }
  if (!lines.some(({ marker }) => marker !== " ")) return false
  if (tool === "Edit") return editIs(lines, input.old_string, input.new_string)
  const newSide = lines.filter(({ marker }) => marker !== "-")
  const content = contentLines(input.content)
  return content !== undefined && matches(newSide, content)
}

/**
 * What the dialog shows of what it asks, when that is the request's tool and input in
 * full: its text, as `detail`; undefined where the screen and the request differ at all.
 * A tool this doesn't know is never read.
 */
const shows = (rows: readonly string[], title: number, facts: RequestFacts): string | undefined => {
  const input = record(facts.input)
  if (!input) return undefined
  const header = (open: number, count: number): string[] =>
    rows.slice(Math.max(0, open - count), open).map((each) => each.trim())
  switch (facts.tool) {
    case "Bash": {
      const command = string(input.command)
      const shown = ruled(rows, title)
      if (!command || !shown || !header(shown.open, 3).includes("Bash command")) return undefined
      // Nothing but the command between its rules.
      return wraps(quoted(shown.body), command) ? quoted(shown.body).join("\n") : undefined
    }
    case "WebFetch": {
      const url = string(input.url)
      const shown = ruled(rows, title)
      if (!url || !shown || !header(shown.open, 3).includes("Fetch")) return undefined
      const prompt = string(input.prompt)
      const expected = `url: ${url}${prompt ? ` prompt: ${prompt}` : ""}`
      return wraps(quoted(shown.body), expected) ? quoted(shown.body).join("\n") : undefined
    }
    case "Read": {
      // `Read(<path>)` between rules, under a "Read file" header.
      const path = string(input.file_path)
      const shown = ruled(rows, title)
      if (!path || Object.keys(input).length !== 1 || !shown) return undefined
      if (!header(shown.open, 3).includes("Read file")) return undefined
      const body = quoted(shown.body)
      return wraps(body, `Read(${path})`) ? body.join("\n") : undefined
    }
    case "Write":
    case "Edit": {
      const path = string(input.file_path)?.replaceAll("\\", "/")
      const close = last(rows.slice(0, title), (each) => dashed.test(each))
      if (!path || close < 1) return undefined
      // A screen cannot show that every occurrence changed, only that one did.
      if (input.replace_all === true) return undefined
      const open = last(rows.slice(0, close), (each) => dashed.test(each))
      // The block's top, its header and its subtitle (the file, as Claude Code writes it
      // relative to its folder), must be on screen: a tall diff scrolls them away, and the
      // question names only the file's own name.
      if (open < 2) return undefined
      const asked = /^Do you want to (create|overwrite|make this edit to) (.+)\?$/.exec(
        rows[title]!.trim(),
      )
      if (!asked) return undefined
      const named = rows[open - 1]!.trim().replaceAll("\\", "/")
      const over = asked[1] === "overwrite"
      // The header and the question's verb agree with the tool, the question names the
      // subtitle's file, and the subtitle resolves to the request's.
      const label = rows[open - 2]?.trim()
      const expected = facts.tool === "Edit" ? "Edit file" : over ? "Overwrite file" : "Create file"
      if (label !== expected || (facts.tool === "Edit") !== (asked[1] === "make this edit to")) {
        return undefined
      }
      if (named === "" || asked[2]!.replaceAll("\\", "/") !== named.split("/").pop())
        return undefined
      if (!samePath(path, named, cwdOf(facts))) return undefined
      const diff = rows.slice(open + 1, close)
      if (!diffIs(diff, facts.tool, over, input, rows[close]!.length)) return undefined
      return [named, ...quoted(diff)].join("\n")
    }
    default: {
      const mcp = /^mcp__(.+)__([^_].*)$/.exec(facts.tool)
      if (!mcp) return undefined
      const at = rows.findIndex((each, index) => index < title && each.endsWith("(MCP)"))
      const named = /^ (.+?) — (.+?) Tool: \(MCP\)$/.exec(rows[at] ?? "")
      if (!named || at < 1 || rows[at - 1]!.trim() !== "Tool use") return undefined
      if (norm(named[1]!) !== norm(mcp[1]!) || norm(named[2]!) !== norm(mcp[2]!)) return undefined
      // The arguments, one `name: value` row each, between ╌ rules; none, no rules.
      const entries = Object.entries(input).map(
        ([key, value]) => `${key}: ${JSON.stringify(value)}`,
      )
      const after = rows.slice(at + 1, title)
      const open = after.findIndex((each) => dashed.test(each))
      if (entries.length === 0) {
        return open < 0 && !after.some((each) => dashed.test(each)) ? "" : undefined
      }
      if (open !== 0) return undefined
      const close = after.findIndex((each, index) => index > 0 && dashed.test(each))
      if (close < 0) return undefined
      const args = quoted(after.slice(1, close))
      return wraps(args, entries.join(" ")) ? args.join("\n") : undefined
    }
  }
}

const telling = (label: string): boolean => label.startsWith("No, and tell Claude")

const permission = (rows: readonly string[], facts: RequestFacts): DialogRead | undefined => {
  if (facts.kind !== "permission") return undefined
  const at = last(rows, (each) => permissionTitle.test(each))
  if (at < 0) return undefined
  const read = numbered(rows, at + 1, permissionOption, permissionContinuation)
  if (!read) return undefined
  if (read.rest.length > 1 || (read.rest.length === 1 && !permissionFooter.test(read.rest[0]!))) {
    return undefined
  }
  const detail = shows(rows, at, facts)
  if (detail === undefined) return undefined
  const title = permissionTitle.exec(rows[at]!)![1]!
  // "No" interrupts the turn and Claude Code asks "What should Claude do instead?": the
  // person's next prompt is the answer (probed 2.1.287 and 2.1.291). Where the dialog says
  // so itself ("No, and tell Claude what to do differently (esc)") that option takes the
  // words; where it only says "No", a copy of it does.
  const refusal = read.options.find(({ label }) => label === "No" || telling(label))
  const prompts = new Set(read.options.filter(({ label }) => telling(label)).map(({ n }) => n))
  const emulated =
    refusal && !telling(refusal.label)
      ? [{ id: "tell", label: "No, and tell Claude what to do", presses: refusal.n }]
      : []
  return choices(
    title,
    detail === "" ? null : detail,
    read.options,
    ({ n }, answer) => {
      const key = digit(n)
      return key && answer.text === undefined ? [{ press: key }] : undefined
    },
    // Gone: this request's dialog doesn't read any more, and the prompt is back.
    (later) => permission(later, facts) === undefined && idle(later),
    undefined,
    prompts,
    emulated,
  )
}

// ---------------------------------------------------------------------------------------
// ExitPlanMode

const planTitle = /^ {3}Exit plan mode\?$/
const planAsk = "Claude has written up a plan and is ready to execute. Would you like to proceed?"
const planQuestion = /Would you like to proceed\?$/
const planOption = /^ {3}(❯| ) (\d+)\. (.+)$/
const shortOption = /^ {4}(❯| ) (\d+)\. (.+)$/
const planHint = /^ {8}shift\+tab to approve with this feedback$/
const feedback = "Tell Claude what to change"

/** Whether the options' marker sits on row `n`, as a field opening there leaves it. */
const marked = (rows: readonly string[], row: RegExp, n: number): boolean =>
  rows.some((each) => {
    const match = row.exec(each)
    return match?.[1] === "❯" && Number(match[2]) === n
  })

const plan = (rows: readonly string[], facts: RequestFacts): DialogRead | undefined => {
  if (facts.kind !== "plan" || facts.tool !== "ExitPlanMode") return undefined
  const input = record(facts.input)
  if (!input) return undefined
  const file = string(input.planFilePath)?.replaceAll("\\", "/")
  const gone = (later: readonly string[]): boolean =>
    !later.some((each) => planTitle.test(each) || planQuestion.test(each)) && idle(later)

  const long = last(rows, (each) => planQuestion.test(each))
  if (long >= 0) {
    // "Ready to code?": the plan's file names this request.
    const name = file?.split("/").pop()
    if (!name) return undefined
    const before = last(rows.slice(0, long), (each) => each !== "")
    const lines = [rows[before] ?? "", rows[long]!].map((each) => each.trim())
    const asked = flat(lines.join(" "))
    if (asked !== flat(planAsk) && flat(lines[1]!) !== flat(planAsk)) return undefined
    const read = numbered(rows, long + 1, planOption, /^ {9,}\S/, planHint)
    if (!read || read.options.length !== 3 || read.options[2]!.label !== feedback) return undefined
    // With the highlight on the field a digit would be typed into it.
    if (read.options[2]!.marker) return undefined
    // The footer wraps with the width; the file is its last word.
    if (
      !flat(read.rest.join("")).startsWith("ctrl+gtoeditinVim·") ||
      !flat(read.rest.join("")).endsWith(flat(name))
    ) {
      return undefined
    }
    return choices(
      "Ready to code?",
      null,
      read.options,
      ({ n }, answer) => {
        const key = digit(n)
        if (!key) return undefined
        if (n === 3) {
          if (answer.text === undefined || !typeable(answer.text)) return undefined
          return [
            { press: key },
            {
              until: (later) => marked(later, planOption, 3),
              timeoutMs,
              why: "the feedback field open",
            },
            { type: answer.text },
            {
              until: (later) => landed(later, planOption, 3, answer.text!),
              timeoutMs,
              why: "the words in the feedback field",
            },
            { press: Enter },
          ]
        }
        return answer.text === undefined ? [{ press: key }] : undefined
      },
      gone,
      3,
    )
  }

  // "Exit plan mode?": no plan, no file.
  const short = last(rows, (each) => planTitle.test(each))
  if (short < 0 || file !== undefined || string(input.plan) !== undefined) return undefined
  const says = rows.findIndex((each, at) => at > short && each !== "")
  if (rows[says] !== "    Claude wants to exit plan mode") return undefined
  const read = numbered(rows, says + 1, shortOption, /^ {9,}\S/)
  if (!read || read.options.length !== 2 || read.rest.length > 0) return undefined
  if (read.options[1]!.label !== "No") return undefined
  return choices(
    "Exit plan mode?",
    null,
    read.options,
    ({ n }, answer) => {
      const key = digit(n)
      return key && answer.text === undefined ? [{ press: key }] : undefined
    },
    gone,
  )
}

// ---------------------------------------------------------------------------------------
// AskUserQuestion

type Ask = {
  readonly question: string
  readonly header: string
  readonly multiSelect: boolean
  readonly options: readonly {
    readonly label: string
    readonly description: string
    readonly preview: boolean
  }[]
}

const asks = (input: unknown): Ask[] | undefined => {
  const questions = record(input)?.questions
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 8) return undefined
  const read: Ask[] = []
  for (const each of questions as unknown[]) {
    const fields = record(each)
    const question = string(fields?.question)
    const header = string(fields?.header)
    const options = fields?.options
    if (!fields || !question || !header || !Array.isArray(options)) return undefined
    if (options.length < 1 || options.length > 16) return undefined
    if (fields.multiSelect !== undefined && typeof fields.multiSelect !== "boolean")
      return undefined
    const listed: { label: string; description: string; preview: boolean }[] = []
    for (const option of options as unknown[]) {
      const fieldsOf = record(option)
      const label = string(fieldsOf?.label)
      if (!fieldsOf || !label) return undefined
      if (fieldsOf.description !== undefined && typeof fieldsOf.description !== "string") {
        return undefined
      }
      listed.push({
        label,
        description: (fieldsOf.description as string | undefined) ?? "",
        preview: string(fieldsOf.preview) !== undefined,
      })
    }
    read.push({
      question,
      header,
      multiSelect: fields.multiSelect === true,
      options: listed,
    })
  }
  return read
}

const questionFooter = /^Enter to select · (?:↑\/↓|Tab\/Arrow keys) to navigate/
const tabBar = /^←\s+(.+?)\s+✔ Submit\s+→$/
const tabs = /([☐☒]) (.+?)(?=  [☐☒] |$)/g
const questionOption = /^(❯| ) (\d+)\. (.+)$/
const review = "Ready to submit your answers?"

const footerAt = (rows: readonly string[]): number =>
  last(rows, (each) => questionFooter.test(each))

/**
 * The question a screen shows, as `questions` reads it: what stands between the tab bar
 * (or header) and the first option, and the headers on the bar; undefined where the
 * screen is no question's.
 */
const shownQuestion = (
  rows: readonly string[],
):
  | {
      readonly question: string
      readonly headers: readonly string[]
      readonly first: number
      readonly footer: number
    }
  | undefined => {
  const footer = footerAt(rows)
  if (footer < 0) return undefined
  const first = last(rows.slice(0, footer), (each) => /^(❯| ) 1\. /.test(each))
  if (first < 1) return undefined
  for (let at = first - 1; at >= 0 && first - at <= 12; at--) {
    if (rule.test(rows[at]!)) return undefined
    const bar = tabBar.exec(rows[at]!)
    if (bar || /^ ☐ .+$/.test(rows[at]!)) {
      const text = rows
        .slice(at + 1, first)
        .filter((each) => each !== "")
        .map((each) => each.replace(/^│ ?/, ""))
      return {
        first,
        footer,
        question: flat(text.join("")),
        headers: bar
          ? [...bar[1]!.matchAll(tabs)].map((each) => flat(each[2]!))
          : [flat(rows[at]!.slice(3))],
      }
    }
  }
  return undefined
}

// Whether a question screen is `ask`'s own: its question is all that stands above its
// options, its header is among the tabs, and its options are its own, read as the first
// question's are.
const showing = (rows: readonly string[], ask: Ask, count: number, final: boolean): boolean => {
  const shown = shownQuestion(rows)
  return (
    shown !== undefined &&
    shown.question === flat(ask.question) &&
    shown.headers.includes(flat(ask.header)) &&
    optionsOf(rows, shown.first, shown.footer, ask, false, count, final) !== undefined
  )
}

const reviewing = (rows: readonly string[]): boolean => rows.includes(review)

type Entry = { n: number; marker: boolean; text: string; lines: string[] }

/**
 * The option rows of a question screen, between its first option and its footer, when
 * they are `ask`'s in full and in the layout probed: its options with their descriptions,
 * then Type something, a rule, and Chat about this (or the preview layout's rows); the
 * highlight on one row and not on the free-text field. `last` says the question is the
 * last of its dialog, where the row after Type something of a multi-select may say Submit.
 */
const optionsOf = (
  rows: readonly string[],
  first: number,
  footer: number,
  ask: Ask,
  preview: boolean,
  askedCount: number,
  isLast: boolean,
): Entry[] | undefined => {
  const count = ask.options.length
  // The row after "Type something" of a multi-select goes on: to the next question, or
  // to submit the last one.
  const goes = askedCount === 1 ? ["Submit"] : isLast ? ["Next", "Submit"] : ["Next"]
  const entries: Entry[] = []
  let ruledAt = -1
  for (const row of rows.slice(first, footer)) {
    if (row === "") continue
    if (rule.test(row)) {
      ruledAt = entries.length
      continue
    }
    const match = questionOption.exec(row)
    if (match) {
      entries.push({ n: Number(match[2]), marker: match[1] === "❯", text: match[3]!, lines: [] })
    } else if (preview && /^ {3,}/.test(row)) {
      // The preview's box, and its notes.
    } else if (preview && row === "  Chat about this" && ruledAt === entries.length) {
      entries.push({ n: 0, marker: false, text: "Chat about this", lines: [] })
    } else if (!preview && /^ {5,}\S/.test(row) && entries.length > 0) {
      entries[entries.length - 1]!.lines.push(row.trim())
    } else return undefined
  }
  if (entries.filter(({ marker }) => marker).length !== 1) return undefined

  if (preview) {
    if (entries.length !== count + 1 || entries[count]!.n !== 0) return undefined
    for (const [at, each] of ask.options.entries()) {
      const entry = entries[at]!
      // The label ends where the preview's box begins.
      if (entry.n !== at + 1 || entry.text.split(/\s{2,}/)[0] !== each.label) return undefined
    }
    if (!rows[first]!.includes("┌")) return undefined
  } else {
    if (entries.length !== count + 2 || ruledAt !== count + 1) return undefined
    for (const [at, each] of ask.options.entries()) {
      const entry = entries[at]!
      const label = ask.multiSelect ? /^\[ \] (.+)$/.exec(entry.text)?.[1] : entry.text
      if (entry.n !== at + 1 || label !== each.label) return undefined
      if (flat(entry.lines.join("")) !== flat(each.description)) return undefined
    }
    const other = entries[count]!
    const chat = entries[count + 1]!
    const typed = ask.multiSelect ? "[ ] Type something" : "Type something."
    if (other.n !== count + 1 || other.text !== typed) return undefined
    // The row after "Type something" of a multi-select goes on: to the next question, or
    // to submit the last one.
    if (!(ask.multiSelect ? goes : [""]).includes(flat(other.lines.join("")))) return undefined
    if (chat.n !== count + 2 || chat.text !== "Chat about this" || chat.lines.length > 0) {
      return undefined
    }
    // With the highlight on the free-text row a digit would be typed into its field.
    if (other.marker) return undefined
    // Digits reach one digit's rows; a longer list is beyond what is probed.
    if (count + 2 > 9) return undefined
  }

  return entries
}

const questions = (rows: readonly string[], facts: RequestFacts): DialogRead | undefined => {
  if (facts.kind !== "question" || facts.tool !== "AskUserQuestion") return undefined
  const asked = asks(facts.input)
  if (!asked) return undefined
  const preview = asked.some(({ options }) => options.some(({ preview: shown }) => shown))
  if (preview) {
    // Only one question, singly selected, with every option previewed, is probed.
    if (asked.length !== 1 || asked[0]!.multiSelect) return undefined
    if (asked[0]!.options.some(({ preview: shown }) => !shown)) return undefined
  }

  const footer = footerAt(rows)
  if (footer < 0) return undefined
  const first = last(rows.slice(0, footer), (each) => /^(❯| ) 1\. /.test(each))
  if (first < 1) return undefined

  // The tab bar or the header, and the question between it and the first option.
  let header = -1
  for (let at = first - 1; at >= 0 && first - at <= 12; at--) {
    if (rule.test(rows[at]!)) break
    if (tabBar.test(rows[at]!) || /^ ☐ .+$/.test(rows[at]!)) {
      header = at
      break
    }
  }
  if (header < 0) return undefined
  const bar = tabBar.exec(rows[header]!)
  const headers = bar
    ? [...bar[1]!.matchAll(tabs)].map((each) => ({ open: each[1] === "☐", name: each[2]! }))
    : [{ open: true, name: rows[header]!.slice(3) }]
  // A lone multi-select question has a tab bar too, for its Submit; a lone single-select
  // question has none.
  if (bar ? asked.length < 2 && !asked[0]!.multiSelect : asked.length !== 1) return undefined
  if (bar && preview) return undefined
  if (headers.length !== asked.length) return undefined
  if (headers.some(({ open, name }, at) => !open || flat(name) !== flat(asked[at]!.header))) {
    return undefined
  }
  const text = rows
    .slice(header + 1, first)
    .filter((each) => each !== "")
    .map((each) => each.replace(/^│ ?/, ""))
  const ask = asked[0]!
  if (text.length === 0 || flat(text.join("")) !== flat(ask.question)) {
    return undefined
  }

  const entries = optionsOf(rows, first, footer, ask, preview, asked.length, asked.length === 1)
  if (!entries) return undefined

  const marker = entries.findIndex((each) => each.marker)
  const dialog: ReadDialog = {
    type: "questions",
    // The "Chat about this" row, read in full above: it rejects the questions, tells the
    // model the person wants to clarify them, and the person's words go as the next prompt.
    chat: "prompt",
    questions: asked.map((each, index) => ({
      id: `q${index + 1}`,
      header: each.header,
      question: each.question,
      options: each.options.map(({ label, description }, at) => ({
        id: String(at + 1),
        label,
        description: description === "" ? null : description,
      })),
      multiSelect: each.multiSelect,
      text: !preview,
    })),
  }

  return {
    dialog,
    keys: (answer) =>
      answer.type === "chat"
        ? chatKeys(ask.options.length, preview, marker)
        : keysFor(asked, preview, marker, answer),
    answered: (later) =>
      idle(later) &&
      !reviewing(later) &&
      !(footerAt(later) >= 0 && showing(later, ask, asked.length, asked.length === 1)),
  }
}

/**
 * The keys that set the questions aside: the digit of the "Chat about this" row, the one
 * after "Type something"; in the preview layout, which has no digits, arrows down to it
 * and Enter. The words, if any, are the driver's to send as the next prompt.
 */
const chatKeys = (
  count: number,
  preview: boolean,
  marker: number,
): readonly KeyStep[] | undefined => {
  if (!preview) {
    const key = digit(count + 2)
    return key ? [{ press: key }] : undefined
  }
  const steps: KeyStep[] = []
  for (let step = 0; step < count - marker; step++) steps.push({ press: Down })
  steps.push({
    until: settled((rows) => rows.some((each) => each === "❯ Chat about this")),
    timeoutMs,
    why: "the highlight on Chat about this",
  })
  steps.push({ press: Enter })
  return steps
}

const checked = (n: number) => (rows: readonly string[]) =>
  rows.some((each) => {
    const match = questionOption.exec(each)
    return match !== null && Number(match[2]) === n && match[3]!.startsWith("[✔] ")
  })

const keysFor = (
  asked: readonly Ask[],
  preview: boolean,
  marker: number,
  answer: RequestAnswer,
): readonly KeyStep[] | undefined => {
  if (answer.type !== "questions" || answer.answers.length !== asked.length) return undefined
  // Several questions, or a multi-select, end on a review screen that takes 1 to submit.
  const reviewed = asked.length > 1 || asked[0]!.multiSelect
  const steps: KeyStep[] = []
  for (const [index, ask] of asked.entries()) {
    const given = answer.answers.filter(({ question }) => question === `q${index + 1}`)
    if (given.length !== 1) return undefined
    const { options, text } = given[0]!
    const picked = options.map((id) => ask.options.findIndex((_, at) => String(at + 1) === id))
    if (picked.some((at) => at < 0) || new Set(picked).size !== picked.length) return undefined
    const count = ask.options.length

    if (preview) {
      // Digits only move the highlight here: arrows to the option, then Enter.
      if (text !== undefined || picked.length !== 1) return undefined
      const target = picked[0]!
      for (let step = 0; step < Math.abs(target - marker); step++) {
        steps.push({ press: target > marker ? Down : Up })
      }
      steps.push({
        until: (rows) =>
          rows.some((each) => {
            const match = questionOption.exec(each)
            return match?.[1] === "❯" && Number(match[2]) === target + 1
          }),
        timeoutMs,
        why: `the highlight on option ${target + 1}`,
      })
      steps.push({ press: Enter })
    } else if (ask.multiSelect) {
      if (picked.length < 1 && text === undefined) return undefined
      if (text !== undefined && !typeable(text)) return undefined
      for (const at of picked) {
        const key = digit(at + 1)
        if (!key) return undefined
        steps.push({ press: key })
        steps.push({ until: checked(at + 1), timeoutMs, why: `option ${at + 1} ticked` })
      }
      if (text === undefined) steps.push({ press: Right })
      else {
        // Its digit only ticks the "Type something" row: arrows from where the highlight
        // starts (the read's for the first question, the first row after) focus it, and
        // the text ticks it. Down leaves it for the row that goes on.
        const start = index === 0 ? marker : 0
        for (let step = 0; step < Math.abs(count - start); step++) {
          steps.push({ press: count > start ? Down : Up })
        }
        steps.push({
          until: (rows) =>
            marked(rows, questionOption, count + 1) &&
            rows.some((each) => each.includes("ctrl+g to edit in Vim")),
          timeoutMs,
          why: "the free-text row focused",
        })
        steps.push({ type: text })
        steps.push({
          until: (rows) => landed(rows, questionOption, count + 1, text, "[✔] "),
          timeoutMs,
          why: "the words in the free-text row",
        })
        steps.push({ press: Down })
        steps.push({
          until: (rows) => rows.some((each) => /^❯ {4}(?:Next|Submit)$/.test(each)),
          timeoutMs,
          why: "the row that goes on highlighted",
        })
        steps.push({ press: Enter })
      }
    } else if (text !== undefined) {
      // The "Type something" row opens a field once the screen shows it focused.
      const key = digit(count + 1)
      if (!key || picked.length > 0 || !typeable(text)) return undefined
      steps.push({ press: key })
      steps.push({
        until: (rows) =>
          marked(rows, questionOption, count + 1) &&
          rows.some((each) => each.includes("ctrl+g to edit in Vim")),
        timeoutMs,
        why: "the free-text row focused",
      })
      steps.push({ type: text })
      steps.push({
        until: (rows) => landed(rows, questionOption, count + 1, text),
        timeoutMs,
        why: "the words in the free-text row",
      })
      steps.push({ press: Enter })
    } else {
      const key = picked.length === 1 ? digit(picked[0]! + 1) : undefined
      if (!key) return undefined
      steps.push({ press: key })
    }

    // Several questions: wait for the next one, or for the review screen after the last.
    if (reviewed) {
      const next = asked[index + 1]
      steps.push({
        // The next question shows with its highlight on its first row, never on a field.
        until: next
          ? (rows) =>
              showing(rows, next, asked.length, index + 1 === asked.length - 1) &&
              marked(rows, questionOption, 1)
          : reviewing,
        timeoutMs,
        why: next ? `question ${index + 2} shown` : "the review screen",
      })
    }
  }
  if (reviewed) steps.push({ press: "1" })
  return steps
}

// ---------------------------------------------------------------------------------------
// MCP elicitation forms

type FormField = {
  readonly id: string
  readonly label: string
  readonly description: string | null
  readonly kind: "text" | "number" | "boolean" | "choice"
  readonly choices: readonly string[]
  readonly required: boolean
}
type Form = { readonly server: string; readonly message: string; readonly fields: FormField[] }

/**
 * The form an Elicitation hook asked, when it is one this reads: a text, number, boolean
 * or enum (of strings) field, each with a title and at most a description. Anything the
 * probes didn't draw (formats, limits, defaults, other types) is not read.
 */
const formOf = (input: unknown): Form | undefined => {
  const fields = record(input)
  const server = string(fields?.mcp_server_name)
  const message = string(fields?.message)
  const schema = record(fields?.requested_schema)
  const properties = record(schema?.properties)
  if (!fields || !server || !message || fields.mode !== "form" || !schema || !properties) {
    return undefined
  }
  if (Object.keys(schema).some((key) => !["type", "properties", "required"].includes(key))) {
    return undefined
  }
  const required = schema.required === undefined ? [] : schema.required
  if (schema.type !== "object" || !Array.isArray(required)) return undefined
  if (required.some((each) => typeof each !== "string" || !(each in properties))) return undefined
  const ids = Object.keys(properties)
  if (ids.length < 1 || ids.length > 8 || server.includes("\n")) return undefined
  const read: FormField[] = []
  for (const id of ids) {
    const each = record(properties[id])
    const label = string(each?.title)
    if (!each || !label || label.includes("\n")) return undefined
    if (Object.keys(each).some((key) => !["type", "title", "description", "enum"].includes(key))) {
      return undefined
    }
    if (each.description !== undefined && !string(each.description)) return undefined
    const description = (each.description as string | undefined) ?? null
    const enums = each.enum
    if (enums !== undefined) {
      const listed = Array.isArray(enums) ? (enums as unknown[]) : []
      if (each.type !== "string" || listed.length < 1 || listed.length > 32) return undefined
      if (listed.some((value) => !string(value) || (value as string).includes("\n"))) {
        return undefined
      }
      if (new Set(listed).size !== listed.length) return undefined
      read.push({
        id,
        label,
        description,
        kind: "choice",
        choices: listed as string[],
        required: required.includes(id),
      })
      continue
    }
    const kind = { string: "text", number: "number", boolean: "boolean" }[String(each.type)] as
      | "text"
      | "number"
      | "boolean"
      | undefined
    if (!kind) return undefined
    read.push({ id, label, description, kind, choices: [], required: required.includes(id) })
  }
  return { server, message, fields: read }
}

type FieldState = {
  readonly hl: boolean
  readonly status: string
  readonly value: string
  readonly lines: readonly string[]
  /** An enum's rows, once expanded. */
  readonly options: readonly { readonly hl: boolean; readonly label: string }[]
}
type FormScreen = {
  readonly fields: readonly FieldState[]
  readonly buttons: "accept" | "decline" | null
  readonly rows: readonly string[]
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const formButtons = /^ {2}(?:❯ | {2})Accept(?: {4}| {2}❯ )Decline$/
const formOptionRow = /^ {8}(❯ | {2})◯ (.+)$/
const formFooter = "  Esc to cancel · ↑/↓ to navigate"

/** The form on screen, row by row, in the order of its fields; undefined unless all of it reads. */
const formScreen = (rows: readonly string[], form: Form): FormScreen | undefined => {
  const heading = last(rows, (each) => each === `  MCP server “${form.server}” requests your input`)
  if (heading < 0) return undefined
  const after = rows.slice(heading + 1)
  const open = (field: FormField) =>
    new RegExp(`^ {2}(❯| ) ([*✔⚠ ]) ${escaped(field.label)}: (.*)$`)
  const first = after.findIndex((each) => open(form.fields[0]!).test(each))
  if (first < 0 || !wraps(quoted(after.slice(0, first)), form.message)) return undefined
  const states: FieldState[] = []
  let at = first
  for (const [index, field] of form.fields.entries()) {
    const match = open(field).exec(after[at] ?? "")
    if (!match) return undefined
    const lines: string[] = []
    const options: { hl: boolean; label: string }[] = []
    at++
    const next = form.fields[index + 1]
    for (; at < after.length; at++) {
      const row = after[at]!
      if (row === "") continue
      if (formButtons.test(row) || (next && open(next).test(row))) break
      const choice = formOptionRow.exec(row)
      if (choice) options.push({ hl: choice[1] === "❯ ", label: choice[2]! })
      else if (/^ {8}\S/.test(row)) lines.push(row.trim())
      else return undefined
    }
    states.push({
      hl: match[1] === "❯",
      status: match[2]!,
      value: match[3]!,
      lines,
      options,
    })
  }
  const buttons = formButtons.exec(after[at] ?? "")
  if (!buttons) return undefined
  const footer = after.slice(at + 1).filter((each) => each !== "")
  if (footer.length !== 1 || !footer[0]!.startsWith(formFooter)) return undefined
  const row = after[at]!
  return {
    fields: states,
    buttons: row.includes("❯ Accept") ? "accept" : row.includes("❯ Decline") ? "decline" : null,
    rows: footer,
  }
}

// What each field reads as before anything is entered, by its kind and whether it is
// highlighted: as the probes drew them.
const untouched = (field: FormField, state: FieldState, hl: boolean): boolean => {
  const value =
    field.kind === "boolean"
      ? hl
        ? "☐"
        : "not set"
      : field.kind === "choice"
        ? hl
          ? "▸ not set"
          : "not set"
        : hl
          ? "Type something…"
          : "not set"
  const described = field.description === null ? "" : flat(field.description)
  return (
    state.hl === hl &&
    state.status === (field.required ? "*" : " ") &&
    state.value === value &&
    state.options.length === 0 &&
    flat(state.lines.join("")) === described
  )
}

/**
 * A step's wait that holds only once the screen has shown its test for `ms`. The form
 * handles a key against the highlight it drew before, until it redraws: Down then Space
 * sent at once toggled the field left behind, and an Enter on Accept sent at once did
 * nothing (probed 2026-10-06, `form-required-bool`, `form-accept-text`). A wait that
 * only saw the highlight arrive would pass either way, so each also checks every other
 * field and takes a moment of the screen holding still.
 */
const settled = (test: (rows: readonly string[]) => boolean, ms = 400) => {
  let since: number | undefined
  return (rows: readonly string[]): boolean => {
    if (!test(rows)) {
      since = undefined
      return false
    }
    since ??= Date.now()
    return Date.now() - since >= ms
  }
}

const formKeys = (form: Form, answer: RequestAnswer): readonly KeyStep[] | undefined => {
  if (answer.type !== "form") return undefined
  const { fields } = form
  const given = answer.action === "accept" ? answer.values : {}
  // A field as the answer leaves it: its value shown and valid, or untouched.
  const finished = (field: FormField, state: FieldState): boolean => {
    const value = given[field.id]
    if (value === undefined) return untouched(field, state, state.hl)
    const described = field.description === null ? "" : flat(field.description)
    if (state.status !== "✔" || flat(state.lines.join("")) !== described) return false
    switch (field.kind) {
      case "text":
        return typeof value === "string" && state.value.startsWith(value.trimStart().slice(0, 20))
      case "number":
        return state.value === String(value)
      case "boolean":
        return state.value === (value ? "☒" : "☐")
      default:
        // Highlighted, a chosen enum reads `▸ green`; not, plain `green`.
        return state.value === String(value) || state.value === `▸ ${String(value)}`
    }
  }
  // Every field but `current` is as it should be by then: those before it finished, those
  // after it untouched, so a key that landed on the wrong field fails the wait.
  const others = (screen: FormScreen, current: number): boolean =>
    fields.every((field, at) => {
      const state = screen.fields[at]!
      if (at === current) return true
      return at < current ? finished(field, state) : untouched(field, state, state.hl)
    })
  const wait = (test: (screen: FormScreen) => boolean, why: string, current: number): KeyStep => ({
    until: settled((rows) => {
      const screen = formScreen(rows, form)
      return screen !== undefined && others(screen, current) && test(screen)
    }),
    timeoutMs: 5000,
    why,
  })
  const onField = (index: number) => (screen: FormScreen) =>
    screen.fields.every((each, at) => each.hl === (at === index)) && screen.buttons === null
  const steps: KeyStep[] = []
  const toButtons = (): void => {
    for (let index = 0; index < fields.length; index++) {
      steps.push({ press: Down })
      steps.push(
        index + 1 < fields.length
          ? wait(onField(index + 1), `field ${index + 2} highlighted`, index + 1)
          : wait((screen) => screen.buttons === "accept", "Accept highlighted", fields.length),
      )
    }
  }

  if (answer.action === "decline") {
    if (Object.keys(answer.values).length > 0) return undefined
    toButtons()
    steps.push({ press: Right })
    steps.push(wait((screen) => screen.buttons === "decline", "Decline highlighted", fields.length))
    steps.push({ press: Enter })
    return steps
  }

  const known = new Set(fields.map(({ id }) => id))
  if (Object.keys(answer.values).some((id) => !known.has(id))) return undefined
  if (fields.some(({ id, required }) => required && !(id in answer.values))) return undefined
  for (const [index, field] of fields.entries()) {
    const value = answer.values[field.id]
    if (value !== undefined) {
      const row = (screen: FormScreen) => screen.fields[index]!
      if (field.kind === "text") {
        if (typeof value !== "string" || value === "" || !typeable(value)) return undefined
        const start = value.trimStart().slice(0, 20)
        steps.push({ type: value })
        steps.push(
          wait(
            (screen) => row(screen).status === "✔" && row(screen).value.startsWith(start),
            `the words in field ${index + 1}`,
            index,
          ),
        )
      } else if (field.kind === "number") {
        if (typeof value !== "number" || !/^-?\d+(?:\.\d+)?$/.test(String(value))) return undefined
        steps.push({ type: String(value) })
        steps.push(
          wait(
            (screen) => row(screen).status === "✔" && row(screen).value === String(value),
            `the number in field ${index + 1}`,
            index,
          ),
        )
      } else if (field.kind === "boolean") {
        if (typeof value !== "boolean") return undefined
        // Space ticks an untouched one (true); once more clears it (false).
        steps.push({ press: " " })
        steps.push(
          wait(
            (screen) => row(screen).status === "✔" && row(screen).value === "☒",
            `field ${index + 1} ticked`,
            index,
          ),
        )
        if (!value) {
          steps.push({ press: " " })
          steps.push(
            wait(
              (screen) => row(screen).status === "✔" && row(screen).value === "☐",
              `field ${index + 1} cleared`,
              index,
            ),
          )
        }
      } else {
        const at = typeof value === "string" ? field.choices.indexOf(value) : -1
        if (at < 0) return undefined
        steps.push({ press: Right })
        steps.push(
          wait(
            (screen) =>
              row(screen).value === "▾" &&
              row(screen).options.length === field.choices.length &&
              row(screen).options.every((each, option) => each.label === field.choices[option]) &&
              row(screen).options[0]!.hl,
            `field ${index + 1} expanded`,
            index,
          ),
        )
        for (let step = 1; step <= at; step++) {
          steps.push({ press: Down })
          steps.push(
            wait(
              (screen) => row(screen).options[step]?.hl === true,
              `choice ${step + 1} highlighted`,
              index,
            ),
          )
        }
        steps.push({ press: " " })
        steps.push(
          wait(
            (screen) => row(screen).status === "✔" && row(screen).value === `▸ ${value}`,
            `field ${index + 1} set`,
            index,
          ),
        )
      }
    }
    steps.push({ press: Down })
    steps.push(
      index + 1 < fields.length
        ? wait(onField(index + 1), `field ${index + 2} highlighted`, index + 1)
        : wait((screen) => screen.buttons === "accept", "Accept highlighted", fields.length),
    )
  }
  // On Accept with every field as the answer says: the wait above checked them all.
  steps.push({ press: Enter })
  return steps
}

const forms = (rows: readonly string[], facts: RequestFacts): DialogRead | undefined => {
  if (facts.kind !== "question" || !facts.tool.startsWith("mcp__")) return undefined
  const form = formOf(facts.input)
  if (!form || facts.tool !== elicitationTool(form.server)) return undefined
  const screen = formScreen(rows, form)
  if (!screen || screen.buttons !== null) return undefined
  // As the probes drew it: the first field highlighted, nothing entered, nothing shown
  // below or above the fields that isn't the form.
  if (!form.fields.every((field, index) => untouched(field, screen.fields[index]!, index === 0))) {
    return undefined
  }
  const dialog: ReadDialog = {
    type: "form",
    message: form.message,
    fields: form.fields.map(({ id, label, description, kind, choices: listed, required }) => ({
      id,
      label,
      description,
      kind,
      choices: [...listed],
      required,
    })),
  }
  return {
    dialog,
    keys: (answer) => formKeys(form, answer),
    // Gone: the form's heading no longer shows, and the prompt is back.
    answered: (later) =>
      idle(later) &&
      !later.some((each) => each === `  MCP server “${form.server}” requests your input`),
  }
}

const trimmed = (rows: readonly string[]): string[] => rows.map((each) => each.trimEnd())

// The read with every screen it is later given trimmed the way it was read.
const tidy = (read: DialogRead | undefined): DialogRead | undefined =>
  read && {
    dialog: read.dialog,
    keys: (answer) =>
      read
        .keys(answer)
        ?.map((step) =>
          "until" in step
            ? { ...step, until: (rows: readonly string[]) => step.until(trimmed(rows)) }
            : step,
        ),
    answered: (rows) => read.answered(trimmed(rows)),
  }

export const dialogs: DialogAdapter = {
  read: (rows, facts) => {
    const clean = trimmed(rows)
    switch (facts.kind) {
      case "question":
        return tidy(facts.tool.startsWith("mcp__") ? forms(clean, facts) : questions(clean, facts))
      case "plan":
        return tidy(plan(clean, facts))
      case "permission":
        return tidy(permission(clean, facts))
    }
  },
}
