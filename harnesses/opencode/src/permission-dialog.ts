import type { ScreenText } from "@novadeck/emulator/headless"
import { refuse } from "@novadeck/harness-core/dialogs"
import type {
  AnswerableDialog,
  DialogRead,
  KeyStep,
  RequestFacts,
} from "@novadeck/harness-core/dialogs"

import { blockOf, squash, timeoutMs } from "./dialog-screen.js"

/**
 * opencode's permission dialog (probed 2026-11-22, 1.19.6; fixtures/dialogs.probe.json): in the
 * box's place, `△ Permission required`, a subject row naming the tool (`# Shell command`,
 * `→ Edit notes.txt`, `⚙ Call tool <name>`), what it asks about, then the choices
 * `Allow once   Allow always   Reject` with `ctrl+f fullscreen  ⇆ select  enter confirm` (on a
 * narrow screen that hint has a row of its own). Left and Right move the selection, wrapping, and
 * Enter takes it; a fresh dialog has Allow once selected, which only its colour says, so no
 * key here can check where it stands. Allow always asks again, `△ Always allow`, listing the
 * patterns `- echo *` with `Confirm   Cancel`, and Enter confirms. Reject needs no second step
 * and stops the turn (the model made no further call). Escape rejects too, so it is never sent
 * to a screen that might not be showing a dialog.
 *
 * What the request's facts are: `tool` is the permission's name (`bash`, `edit`, `read`, `webfetch`,
 * an MCP tool's own), `input` its `permission.asked` event's `patterns`, `metadata`, `always`. The
 * dialog is read only where it agrees with them, as below; any other permission reads as
 * unrecognised.
 */

const heading = /^ *┃  △ Permission required\s*$/
const choices = /^Allow once {2,}Allow always {2,}Reject(?: {2,}.*)?$/

const right = "\x1b[C"
const enter = "\r"
const ctrlF = "\x06"

type Facts = {
  readonly patterns: readonly string[]
  readonly metadata: Record<string, unknown>
  readonly always: readonly string[]
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((each) => typeof each === "string")
    ? (value as string[])
    : undefined

// The request's input, whole or none: an object whose lists are lists of strings.
const factsOf = (input: unknown): Facts | undefined => {
  if (typeof input !== "object" || input === null) return refuse("permission.factsOf.1")
  const { patterns, metadata, always } = input as Record<string, unknown>
  const listed = strings(patterns)
  if (!listed) return refuse("permission.factsOf.2")
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
    return refuse("permission.factsOf.3")
  return {
    patterns: listed,
    metadata: metadata as Record<string, unknown>,
    always: strings(always) ?? [],
  }
}

type Shown = {
  /** The subject row, its icon and words: `→ Edit notes.txt`. */
  readonly subject: string
  /** What it asks about, one line per row, its blank rows at either end gone. */
  readonly body: readonly string[]
  /** Which of the three choices is selected, by their order, from the cells lit on their row; undefined where the screen says none or several. */
  readonly selected?: number
  /** Whether it is the fullscreen view (`ctrl+f minimize`), which shows the body whole. */
  readonly fullscreen: boolean
}

const labels = ["Allow once", "Allow always", "Reject"]

// The selected choice: the one text on its row whose cells have a background of their own
// (`ScreenText.lit`), the selected one's against its siblings' (probed 2026-11-22, 1.19.6, the
// colours themselves theme-dependent). None or several lit leaves it unknown.
const selection = (screen: ScreenText | undefined, row: number): number | undefined => {
  // Its gutter is lit too, as the dialog is on a background of its own.
  const lit = screen?.lit?.[row]?.replace(/^\s*┃/, "").trim()
  const found = labels.flatMap((label, at) => (lit === label ? [at] : []))
  return found.length === 1 ? found[0] : undefined
}

// The dialog on screen, read in full: its heading, subject, body, choices and hints.
const shownOn = (rows: readonly string[], screen?: ScreenText): Shown | undefined => {
  const block = blockOf(rows, heading)
  if (!block) return refuse("permission.shownOn.1")
  const lines = block.lines.map((line) => line.trim())
  const at = lines.indexOf("△ Permission required")
  const choice = lines.findIndex((line) => choices.test(line))
  const subject = lines[at + 1]
  if (at < 0 || choice < at + 2 || !subject) return refuse("permission.shownOn.2")
  const hints = lines.slice(choice).join(" ").replaceAll(/ +/g, " ").trim()
  const fullscreen = /ctrl\+f minimize\b/.test(hints)
  if (!/ctrl\+f (?:fullscreen|minimize)\b/.test(hints) || !hints.endsWith("enter confirm"))
    return refuse("permission.shownOn.3")
  // The rows between: blank ones around the body aside, each kept as drawn.
  // A scroll bar, drawn at a row's far end where the body is taller than the view, is no part of it.
  const body = block.lines
    .slice(at + 2, choice)
    .map((line) => line.replace(/ {2,}[█▐▌▀▄]+$/, "").trimEnd())
  while (body.length > 0 && body[0]!.trim() === "") body.shift()
  while (body.length > 0 && body.at(-1)!.trim() === "") body.pop()
  const selected = selection(screen, block.first + choice)
  return { subject, body, fullscreen, ...(selected !== undefined && { selected }) }
}

// A path as it is drawn against the one the request names: relative to where opencode runs,
// with `/` where Windows names it with `\`.
const slashed = (path: string): string => path.replaceAll("\\", "/")
const names = (shown: string, full: unknown): boolean => {
  if (typeof full !== "string" || shown === "") return false
  const whole = slashed(full)
  const part = slashed(shown)
  return whole === part || whole.endsWith(`/${part}`)
}

type Agreed = { readonly detail: string; readonly cut: boolean }

// What `bash` shows: `# Shell command`, then `$ ` and its command's rows.
const command = (shown: Shown, facts: Facts): Agreed | undefined => {
  const wanted = facts.metadata.command
  if (shown.subject !== "# Shell command" || typeof wanted !== "string" || wanted.trim() === "")
    return refuse("permission.command.1")
  const drawn = squash(shown.body.join("\n"))
  const asked = squash(`$ ${wanted}`)
  if (drawn === asked) return { detail: wanted, cut: false }
  // Both of its views end where their rows do, with no mark (the inline one at 7 rows, the
  // fullscreen one scrolling under a bar), and a script taller than any screen can't be shown
  // whole: a start of the command is the command, as `detail` gives it, where nothing else
  // asks (twin commands alike in their first rows can't be told apart, as on Antigravity).
  return drawn.length > 1 && asked.startsWith(drawn)
    ? { detail: wanted, cut: false }
    : refuse("permission.command.2")
}

// The changed and context lines of a unified diff, without their `+`, `-` or space.
const diffLines = (diff: unknown): string[] =>
  typeof diff === "string"
    ? diff
        .split("\n")
        .slice(4)
        .filter((line) => /^[ +-]/.test(line) && !/^(?:---|\+\+\+)/.test(line))
        .map((line) => squash(line.slice(1)))
        .filter((line) => line !== "")
    : []

// What `edit` (a write, a patch too) shows: `→ Edit notes.txt` and the diff, as rows of
// `1 + text`. Its inline view shows the first rows only, with no mark, and its fullscreen view
// scrolls (a `█` bar at the right of its rows) where the diff is taller than the screen: only
// a view that reached the diff's own last line shows all of it.
const edit = (shown: Shown, facts: Facts): Agreed | undefined => {
  const subject = /^[→←] Edit (\S.*)$/.exec(shown.subject)
  if (!subject || !names(subject[1]!, facts.metadata.filepath)) return refuse("permission.edit.1")
  if (shown.body.length === 0) return refuse("permission.edit.2")
  const last = diffLines(facts.metadata.diff).at(-1)
  const reached = last === undefined || squash(shown.body.join("\n")).endsWith(last)
  if (!reached && shown.fullscreen) return refuse("permission.edit.3")
  return { detail: shown.body.join("\n"), cut: !reached }
}

// `% WebFetch <url>` over `URL: <url>`.
const webfetch = (shown: Shown, facts: Facts): Agreed | undefined => {
  const url = facts.metadata.url
  if (typeof url !== "string" || url === "") return refuse("permission.webfetch.1")
  if (shown.subject !== `% WebFetch ${url}`) return refuse("permission.webfetch.2")
  return squash(shown.body.join("\n")) === squash(`URL: ${url}`)
    ? { detail: shown.body.join("\n"), cut: false }
    : refuse("permission.webfetch.3")
}

// `→ Read notes.txt` over `Path: notes.txt`.
const readFile = (shown: Shown, facts: Facts): Agreed | undefined => {
  const subject = /^→ Read (\S.*)$/.exec(shown.subject)
  const path = subject?.[1]
  if (!path || shown.body.length !== 1 || shown.body[0]!.trim() !== `Path: ${path}`)
    return refuse("permission.readFile.1")
  return facts.patterns.some((pattern) => names(path, pattern))
    ? { detail: path, cut: false }
    : refuse("permission.readFile.2")
}

// `✱ Glob "*.txt"` and `✱ Grep "line"`, over `Pattern: *.txt`.
const search =
  (word: string) =>
  (shown: Shown, facts: Facts): Agreed | undefined => {
    const pattern = facts.metadata.pattern
    if (typeof pattern !== "string" || pattern === "") return refuse("permission.search.1")
    if (shown.subject !== `✱ ${word} "${pattern}"`) return refuse("permission.search.2")
    return squash(shown.body.join("\n")) === squash(`Pattern: ${pattern}`)
      ? { detail: pattern, cut: false }
      : refuse("permission.search.3")
  }

// `← Access external directory /etc` over `Patterns` and `- /etc/*` rows.
const external = (shown: Shown, facts: Facts): Agreed | undefined => {
  const dir = facts.metadata.parentDir
  if (typeof dir !== "string" || shown.subject !== `← Access external directory ${dir}`)
    return refuse("permission.external.1")
  const listed = shown.body
    .filter((row) => row.trim().startsWith("- "))
    .map((row) => row.trim().slice(2))
  const ok =
    shown.body[0]?.trim() === "Patterns" &&
    listed.map(squash).join("\n") === facts.patterns.map(squash).join("\n")
  return ok ? { detail: shown.body.join("\n"), cut: false } : refuse("permission.external.2")
}

// `# General Task` over `◉ Look around`: the subagent's type and its description.
const task = (shown: Shown, facts: Facts): Agreed | undefined => {
  const { description, subagent_type: type } = facts.metadata
  if (typeof description !== "string" || typeof type !== "string")
    return refuse("permission.task.1")
  if (shown.subject.toLowerCase() !== `# ${type} task`.toLowerCase())
    return refuse("permission.task.2")
  return squash(shown.body.join("\n")) === squash(`◉ ${description}`)
    ? { detail: description, cut: false }
    : refuse("permission.task.3")
}

// Any other permission, an MCP tool's among them: `⚙ Call tool <name>` over `Tool: <name>`.
const generic = (shown: Shown, tool: string): Agreed | undefined =>
  shown.subject === `⚙ Call tool ${tool}` && shown.body[0]?.trim() === `Tool: ${tool}`
    ? { detail: shown.body.join("\n"), cut: false }
    : refuse("permission.generic.1")

const agreed = (shown: Shown, request: RequestFacts, facts: Facts): Agreed | undefined => {
  switch (request.tool) {
    case "bash":
      return command(shown, facts)
    case "edit":
      return edit(shown, facts)
    case "webfetch":
      return webfetch(shown, facts)
    case "read":
      return readFile(shown, facts)
    case "glob":
      return search("Glob")(shown, facts)
    case "grep":
      return search("Grep")(shown, facts)
    case "external_directory":
      return external(shown, facts)
    case "task":
      return task(shown, facts)
    default:
      return generic(shown, request.tool)
  }
}

// The second dialog Allow always opens, read in full: its patterns, with Confirm and Cancel.
const alwaysPatterns = (rows: readonly string[]): string[] | undefined => {
  const block = blockOf(rows, /^ *┃  △ Always allow\s*$/)
  if (!block) return refuse("permission.alwaysPatterns.1")
  const lines = block.lines.map((line) => line.trim())
  if (!lines.some((line) => /^Confirm {2,}Cancel\b/.test(line)))
    return refuse("permission.alwaysPatterns.2")
  return lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2))
}

// A wait for the second dialog, with exactly the patterns the request says it would allow.
const confirmShown = (always: readonly string[]): KeyStep => ({
  until: (rows) => {
    const found = alwaysPatterns(rows)
    return found !== undefined && found.map(squash).join("\n") === always.map(squash).join("\n")
  },
  timeoutMs,
  why: "the Always allow dialog, with the request's patterns",
})

/** Where its dialog is up as the same one: its subject and body, as drawn, are the read's. */
const same = (rows: readonly string[], shown: Shown): boolean => {
  const now = shownOn(rows)
  return (
    now !== undefined &&
    now.subject === shown.subject &&
    squash(now.body.join("\n")) === squash(shown.body.join("\n"))
  )
}

const title = (subject: string): string => subject.replace(/^\S+\s+/, "")

export const permission = (
  rows: readonly string[],
  request: RequestFacts,
  screen?: ScreenText,
): DialogRead | undefined => {
  const shown = shownOn(rows, screen)
  const facts = factsOf(request.input)
  if (!shown || !facts) return refuse("permission.permission.1")
  const found = agreed(shown, request, facts)
  if (!found) return refuse("permission.permission.2")
  const dialog: AnswerableDialog = {
    type: "choices",
    title: title(shown.subject),
    detail: found.detail,
    // Reject stops the turn, so the person's words may follow it as the next prompt.
    options: [
      { id: "once", label: "Allow once", text: null },
      { id: "always", label: "Allow always", text: null },
      { id: "reject", label: "Reject", text: "prompt" },
    ],
  }
  // Its inline view cut what it asks about: ctrl+f shows it whole, where it is read again.
  if (found.cut) return { dialog, keys: () => undefined, answered: () => false, reveal: ctrlF }
  // Only a selection the screen shows can be moved from: Right wraps, so the presses to a
  // choice depend on where it stands.
  const { selected } = shown
  if (selected === undefined) return refuse("permission.selection.1")
  const moves = (target: number) =>
    Array.from({ length: (target - selected + labels.length) % labels.length }, () => ({
      press: right,
    }))
  return {
    dialog,
    keys: (answer) => {
      if (answer.type !== "choice") return undefined
      if (answer.text !== undefined && answer.option !== "reject") return undefined
      switch (answer.option) {
        case "once":
          return [...moves(0), { press: enter }]
        case "reject":
          return [...moves(2), { press: enter }]
        case "always":
          return facts.always.length === 0
            ? undefined
            : [...moves(1), { press: enter }, confirmShown(facts.always), { press: enter }]
        default:
          return undefined
      }
    },
    answered: (later) => {
      if (alwaysPatterns(later) !== undefined) return false
      return !later.some((row) => heading.test(row)) || !same(later, shown)
    },
  }
}
