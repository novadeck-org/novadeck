import type { AnswerableDialog, DialogRead, RequestFacts } from "@novadeck/harness-core/dialogs"

import {
  collapse,
  footerAfter,
  only,
  type Option,
  optionsFrom,
  rowsLike,
  rule,
} from "./dialog-screen.js"
import { toolCall } from "./tools.js"

/**
 * Antigravity's confirmations (probed 2026-10-06, 1.2.14; fixtures/ask.probe.json): a
 * command's, "Run this command?", a file write's, "Allow creation of this file?", and a
 * file edit's, "Accept this file edit?". Numbered options, one marked with `>`, which a
 * digit takes at once, with no Enter. The options are read from the screen, never
 * assumed: they differ by tool. The request's call (its PreToolUse, which the decoder
 * keeps for the confirmation) must agree with what the screen shows: the command, or the
 * file.
 */

// A path with its separators as one: on Windows 1.4.3 draws a file's path with `/` where
// its call names it with `\` (seen 2026-10-20, 1.4.3).
const slashed = (path: string): string => path.replaceAll("\\", "/")

// A command's rows as one line: each row trimmed, a row break read as one space, every
// other whitespace as it is, so `> x` is not `>x` nor `a  b` `a b` within a row.
const lined = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== "")
    .join(" ")

type Confirmation = {
  readonly question: string
  readonly options: readonly Option[]
  /** What it shows of the call: a command's text, or what stands above the question. */
  readonly shown: string
  readonly command: boolean
  /** A command's rows as drawn (trailing space gone), and the screen's width. */
  readonly drawn?: { readonly rows: readonly string[]; readonly width: number }
  /** A command's tool lines above its heading. */
  readonly history?: string
  /** The tools a file confirmation's header may name. */
  readonly tools?: readonly string[]
}

// A command's confirmation, or a file's, read in full: from `Requesting permission for:`
// (the command it shows) or from above the question, to its footer.
const confirmation = (rows: readonly string[]): Confirmation | undefined => {
  const lines = rows.map((row) => row.trimEnd())
  const ask = only(rowsLike(lines, /^(Run this command\?|Allow [^?]+\?|Accept this file edit\?)$/))
  if (ask === undefined) return undefined
  const options = optionsFrom(lines, ask + 1)
  if (!options || footerAfter(lines, ask + 1) === undefined) return undefined
  const question = lines[ask]!.trim()
  if (question === "Run this command?") {
    const start = lines.findLastIndex(
      (row, index) => index < ask && row.trim() === "Requesting permission for:",
    )
    if (start < 0) return undefined
    const shown = lines
      .slice(start + 1, ask)
      .map((row) => row.trim())
      .join("\n")
      .trim()
    // The tool lines above its heading, which move on as calls run: all that tells one
    // of two identical queued commands from the next (empty where the heading scrolled off).
    const heading = lines.findLastIndex((row, index) => index < start && row.trim() === "Command")
    const history =
      heading < 0
        ? ""
        : lines
            .slice(Math.max(0, heading - 6), heading)
            .filter((row) => row.startsWith("● ") || row.startsWith("○ "))
            .join("\n")
    const drawn = {
      rows: lines.slice(start + 1, ask),
      width: Math.max(0, ...lines.filter(rule).map((row) => row.trim().length)),
    }
    return shown === "" ? undefined : { question, options, shown, command: true, history, drawn }
  }
  // A file's: its header over a rule, then what it shows, down to the question.
  const ruleAt = lines.findLastIndex((row, index) => index < ask && rule(row))
  const header = ruleAt > 0 ? lines[ruleAt - 1]!.trim() : ""
  const tools = toolsByHeader[header]
  if (tools === undefined) return undefined
  // Its edit's hint about auto-approval is no part of what it asks.
  const shown = lines
    .slice(ruleAt + 1, ask)
    .filter((row) => !row.trim().startsWith("shift+tab to auto-approve"))
    .join("\n")
    .trim()
  return shown === "" ? undefined : { question, options, shown, command: false, tools }
}

// The tools each file confirmation's header means (only what was probed): 1.4's, which
// name the file as Path, and the earlier ones, which name it as TargetFile.
const toolsByHeader: { readonly [header: string]: readonly string[] } = {
  // "Allow creation of this file?" (probed 2026-10-20, 1.2.14 and 1.4.3).
  "Create file": ["write_file", "write_to_file"],
  // A line replaced in a file (probed 2026-10-15, 1.2.14 and 1.3.5): "Accept this file edit?".
  "Pending edit": ["edit_file", "replace_file_content"],
}

// Whether what the screen shows of a command is the call's, all of it. A command cut short
// with `...` is no match, as its start could be another call's (parallel calls share one
// remembered call) and no cut-off screen has been probed: it reads raw.
const sameCommand = (shown: string, command: unknown): boolean =>
  typeof command === "string" && command.trim() !== "" && lined(shown) === lined(command)

// Whether the screen shows `command` row for row: each line of it on its own row, or on
// several where the terminal wrapped it. A break inside a line counts as a wrap only where
// the row was full (the next word would not have fit), so two commands on two rows are never
// read as one wrapped line. Without the screen's width nothing counts as wrapped.
const drawnAs = ({ rows, width }: NonNullable<Confirmation["drawn"]>, command: string): boolean => {
  const trimmedRows = rows.map((row) => ({ text: row.trim(), length: row.length }))
  const first = trimmedRows.findIndex((row) => row.text !== "")
  const last = trimmedRows.findLastIndex((row) => row.text !== "")
  if (first < 0) return false
  const shown = trimmedRows.slice(first, last + 1)
  let at = 0
  for (const line of command
    .trim()
    .split(/\r?\n/)
    .map((each) => each.trim())) {
    if (line === "") {
      if (shown[at]?.text !== "") return false
      at += 1
      continue
    }
    let pos = 0
    let previous: (typeof shown)[number] | undefined
    while (pos < line.length) {
      const row = shown[at]
      if (!row || row.text === "") return false
      if (previous) {
        const spaced = line[pos] === " "
        const word = /^\S+/.exec(row.text)?.[0].length ?? 0
        const full = spaced ? previous.length + 1 + word > width : previous.length >= width
        if (width === 0 || !full) return false
        if (spaced) pos += 1
      }
      if (!line.startsWith(row.text, pos)) return false
      pos += row.text.length
      previous = row
      at += 1
    }
  }
  return at === shown.length
}

// Whether the screen's confirmation is about the call the request names.
const matches = (read: Confirmation, input: unknown): boolean => {
  const call = toolCall(input)
  if (!call) return false
  if (read.command)
    return call.name === "run_command" && sameCommand(read.shown, call.args.CommandLine)
  // A file's: the header names the call's tool, and the dialog's own first line, between
  // that header and the question, starts with the call's whole path.
  const file = call.args.Path ?? call.args.TargetFile
  if (typeof file !== "string" || file.trim() === "" || !read.tools?.includes(call.name))
    return false
  const line = read.shown.split("\n")[0]!.replace(/\s+[+-]\d+(\s+[+-]\d+)*\s*$/, "")
  return slashed(collapse(line)) === slashed(collapse(file))
}

const digit = (number: number): string | undefined => (number <= 9 ? String(number) : undefined)

// Commands run, and commands still waiting, as the tool lines above a command's dialog
// tell: 1.2.14 marks a queued call `○` until it is its turn; 1.3.0 folds the ones that ran
// into `● Ran N commands`.
const progress = (history: string): { ran: number; waiting: number } => {
  const rows = history.split("\n")
  const ran = rows.reduce((total, row) => {
    const folded = /^● Ran (\d+) commands? /.exec(row)
    return total + (folded ? Number(folded[1]) : row.startsWith("● Ran (") ? 1 : 0)
  }, 0)
  return { ran, waiting: rows.filter((row) => row.startsWith("○ ")).length }
}

// Whether the tool lines moved on as an answered command's would: more ran, or fewer wait.
// Any other change of them (a redraw, a hint toggled) is nothing.
const progressed = (before: string | undefined, now: string | undefined): boolean => {
  if (!before || !now) return false
  const was = progress(before)
  const is = progress(now)
  return is.ran > was.ran || is.waiting < was.waiting
}

const ownCommand = (read: Confirmation, input: unknown): string | undefined => {
  const command = toolCall(input)?.args.CommandLine
  return read.command && read.drawn && typeof command === "string" && drawnAs(read.drawn, command)
    ? command
    : undefined
}

export const permission = (
  rows: readonly string[],
  request: RequestFacts,
): DialogRead | undefined => {
  const read = confirmation(rows)
  if (!read || !matches(read, request.input)) return undefined
  const keyed = read.options.map(({ number }) => digit(number))
  if (keyed.includes(undefined)) return undefined
  const dialog: AnswerableDialog = {
    type: "choices",
    title: read.question,
    // A command shows as the call runs it, not as the screen drew and wrapped it.
    // Only where the screen shows that very command, row for row: the request is the
    // conversation's latest call, and a parallel call's could read alike once rows join.
    detail: ownCommand(read, request.input) ?? read.shown,
    // Its No refuses and ends the turn (probed), so the person's words may follow it as
    // the next prompt, which the driver sends once the dialog is answered.
    options: read.options.map(({ number, label }) => ({
      id: String(number),
      label,
      text: /^No\b/.test(label) ? ("prompt" as const) : null,
    })),
  }
  return {
    dialog,
    // A digit acts at once. Its Amend (tab) approves with words, which isn't offered. Words
    // go with the No only, as the prompt after it.
    keys: (answer) => {
      if (answer.type !== "choice") return undefined
      const chosen = read.options.find(({ number }) => String(number) === answer.option)
      if (!chosen || (answer.text !== undefined && !/^No\b/.test(chosen.label))) return undefined
      return [{ press: answer.option }]
    },
    answered: (later) => {
      if (!later.some((row) => row.trim() === read.question)) return true
      // Still up, or another call's, as parallel calls show theirs one at a time.
      const next = confirmation(later)
      if (next === undefined) return false
      if (next.shown !== read.shown || next.question !== read.question) return true
      // Identical queued commands: the first is answered once the tool lines moved on.
      return progressed(read.history, next.history)
    },
  }
}
