import type { RequestAnswer } from "@novadeck/protocol"

import type {
  DialogAdapter,
  DialogRead,
  KeyStep,
  ReadDialog,
  RequestFacts,
  ScreenRequest,
} from "../dialogs.js"

/**
 * How Codex's TUI asks the person, and the keys that answer it (probed 2026-10-06, 0.159.3;
 * source `codex-rs/tui/src/bottom_pane/`). Every dialog here is read in full or not at all:
 * its title, its header against what the request's hook said (the command, the files, the
 * tool, the questions), and each option's wording against the wordings Codex has for it.
 * An update that rewords, adds or reorders anything reads as no dialog, and the chat shows
 * the screen's text instead.
 *
 * - Approvals (a command, a patch, extra permissions) take each option's shortcut as the
 *   screen prints it, `(y)`, for the person may rebind them under `[tui.keymap.approval]`;
 *   an option whose shortcut isn't printed is not offered. "No, and tell Codex what to do
 *   differently" aborts the turn, and the words go as the next prompt.
 * - An MCP tool's approval is a form whose rows take their digit, which submits it.
 * - `request_user_input` takes a digit per question, which answers it and moves on; its
 *   words go in the notes (Tab) of the row they belong to, "None of the above" for words alone.
 * - The plan prompt after a plan takes the digits too.
 * An MCP server's own elicitation form is not read.
 */

const squash = (text: string): string => text.replace(/\s+/g, "")

/** Whitespace runs as one space: what a terminal's wrapping and Codex's own spacing keep alike. */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim()

/**
 * Whether `lines`, as the terminal wrapped them, read as `expected`: within a row every
 * character must match, whitespace included; between rows the break may stand for a space,
 * a newline or nothing at all (a long word broken inside). So `> x` is not `>x` and `a  b`
 * is not `a b`.
 */
const wrapped = (lines: readonly string[], expected: string): boolean => {
  const want = expected.trim()
  let at = 0
  for (const line of lines) {
    const part = line.trim()
    if (part === "") continue
    while (at > 0 && at < want.length && /\s/.test(want[at]!)) at += 1
    if (!want.startsWith(part, at)) return false
    at += part.length
  }
  return at >= want.length
}

/** The screen's lines, without trailing space or blank lines. */
const clean = (rows: readonly string[]): readonly string[] =>
  rows.map((row) => row.replace(/\s+$/, "")).filter((row) => row.length > 0)

const indent = (line: string): number => line.length - line.trimStart().length

// A numbered option: the highlight, its number, and what follows.
const optionLine = /^( {0,4})(›)? {0,3}(\d+)\. (\S.*)$/

type Row = {
  readonly n: number
  readonly marked: boolean
  /** The option's first line, from its label on, columns of description and all. */
  readonly head: string
  /** All its lines, wrapped or not, joined by a space. */
  readonly text: string
}

/** The options numbered from 1 that start at `from`, and the line after them. */
const optionsAt = (
  lines: readonly string[],
  from: number,
): { readonly rows: readonly Row[]; readonly next: number } => {
  const rows: Row[] = []
  let at = from
  for (;;) {
    const line = lines[at]
    const found = line === undefined ? null : optionLine.exec(line)
    if (!found || Number(found[3]) !== rows.length + 1) break
    const column = found[0].length - found[4]!.length
    const parts = [found[4]!]
    at += 1
    while (at < lines.length && !optionLine.test(lines[at]!) && indent(lines[at]!) >= column) {
      parts.push(lines[at]!.trim())
      at += 1
    }
    rows.push({
      n: rows.length + 1,
      marked: found[2] !== undefined,
      head: parts[0]!,
      text: parts.join(" "),
    })
  }
  return { rows, next: at }
}

/** The line of the first option in `lines` after `from`, or -1. */
const firstOption = (lines: readonly string[], from: number): number => {
  for (let at = from; at < lines.length; at += 1) {
    const found = optionLine.exec(lines[at]!)
    if (found && found[3] === "1") return at
  }
  return -1
}

const lastIndex = (lines: readonly string[], test: (line: string) => boolean): number =>
  lines.findLastIndex(test)

/** Whether `head` is `label`, alone or followed by its description's column. */
const labelled = (head: string, label: string): boolean =>
  head === label || head.startsWith(`${label}  `)

/** The key an approval's printed shortcut presses, or undefined for one not understood. */
const keyOf = (hint: string): string | undefined => {
  if (hint === "esc") return "\x1b"
  if (hint === "enter") return "\r"
  if (hint === "space") return " "
  if (hint === "tab") return "\t"
  const control = /^ctrl\+([a-z])$/.exec(hint)
  if (control) return String.fromCharCode(control[1]!.charCodeAt(0) - 96)
  return hint.length === 1 && hint >= "!" && hint <= "~" ? hint : undefined
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// What a dialog offers by its own wording: each label Codex has for it, and whether the
// person's words go with it as a prompt after (the option that tells Codex what to do).
type Wording = { readonly label: RegExp; readonly prompt?: true }

const exec: readonly Wording[] = [
  { label: /^Yes, proceed$/ },
  { label: /^Yes, and don't ask again for commands that start with `.+`$/ },
  { label: /^Yes, and don't ask again for this command in this session$/ },
  { label: /^Yes, and allow these permissions for this session$/ },
  { label: /^No, continue without running it$/ },
  { label: /^No, and tell Codex what to do differently$/, prompt: true },
]
const patch: readonly Wording[] = [
  { label: /^Yes, proceed$/ },
  { label: /^Yes, and don't ask again for these files$/ },
  { label: /^No, and tell Codex what to do differently$/, prompt: true },
]
const permissions: readonly Wording[] = [
  { label: /^Yes, grant these permissions for this turn$/ },
  { label: /^Yes, grant for this turn with strict auto review$/ },
  { label: /^Yes, grant these permissions for this session$/ },
  { label: /^No, continue without permissions$/ },
]

const titles = {
  "Would you like to run the following command?": exec,
  "Would you like to make the following edits?": patch,
  "Would you like to grant these permissions?": permissions,
} as const

type Choice = {
  readonly id: string
  readonly label: string
  readonly key: string
  readonly text: "prompt" | null
}

/** What a read dialog is, before it becomes the driver's `DialogRead`. */
type Parsed = {
  readonly dialog: ReadDialog
  readonly keys: (answer: RequestAnswer) => readonly KeyStep[] | undefined
}

const choose = (title: string, picks: readonly Choice[], detail: string | null): Parsed => ({
  dialog: {
    type: "choices",
    title,
    detail,
    options: picks.map(({ id, label, text }) => ({ id, label, text })),
  },
  keys: (answer) => {
    if (answer.type !== "choice") return undefined
    const pick = picks.find(({ id }) => id === answer.option)
    if (!pick || (answer.text !== undefined && pick.text === null)) return undefined
    return [{ press: pick.key }]
  },
})

/** The files a patch writes, as its text names them. */
const patched = (text: string): readonly string[] =>
  [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(
    ([, path]) => path!.trim(),
  )

const slashes = (path: string): string => squash(path).replace(/\\/g, "/")

const sameFile = (destination: string, file: string): boolean => {
  const wanted = slashes(file).replace(/^\.\//, "")
  const shown = destination.replace(/\\/g, "/")
  return shown === wanted || shown.endsWith(`/${wanted}`)
}

/** The lines of the command an exec approval shows, from its `$ ` line to its options. */
const shownCommand = (body: readonly string[]): readonly string[] | undefined => {
  const start = body.findIndex((line) => /^\s*\$ /.test(line))
  if (start < 0) return undefined
  return [body[start]!.replace(/^\s*\$ /, ""), ...body.slice(start + 1)]
}

/** The lines under each `Destination:` of a patch approval, as one path each. */
const shownDestinations = (body: readonly string[]): readonly string[] => {
  const found: string[] = []
  for (const line of body) {
    const start = /^\s*Destination:(.*)$/.exec(line)
    if (start) found.push(squash(start[1]!))
    else if (found.length > 0) found[found.length - 1] += squash(line)
  }
  return found
}

const headers = /^\s*(?:Permission rule|Reason|Environment|Thread|Description|Destination):|^\s*\$ /

/** The lines a header's field takes in an approval's body, from after the header to the next. */
const field = (body: readonly string[], header: string): readonly string[] | undefined => {
  const start = body.findIndex((line) => line.trimStart().startsWith(`${header}:`))
  if (start < 0) return undefined
  const lines = [body[start]!.trimStart().slice(header.length + 1)]
  for (const line of body.slice(start + 1)) {
    if (headers.test(line)) break
    lines.push(line)
  }
  return lines
}

const readApproval = (lines: readonly string[], facts: RequestFacts): Parsed | undefined => {
  if (facts.kind !== "permission") return undefined
  const title = lastIndex(lines, (line) => line.trim() in titles)
  if (title < 0) return undefined
  const name = lines[title]!.trim() as keyof typeof titles
  const first = firstOption(lines, title + 1)
  if (first < 0) return undefined
  const body = lines.slice(title + 1, first)
  const input = object(facts.input)
  let detail: string | null = null

  if (name === "Would you like to run the following command?") {
    if (facts.tool !== "Bash" || typeof input?.command !== "string") return undefined
    const shown = shownCommand(body)
    if (!shown || !wrapped(shown, input.command)) return undefined
    detail = collapse(input.command)
  } else if (name === "Would you like to make the following edits?") {
    if (facts.tool !== "apply_patch" || typeof input?.command !== "string") return undefined
    const files = patched(input.command)
    const shown = shownDestinations(body)
    if (files.length === 0 || shown.length === 0) return undefined
    if (!shown.every((each) => files.some((file) => sameFile(each, file)))) return undefined
    if (!files.every((file) => shown.some((each) => sameFile(each, file)))) return undefined
    detail = shown.join("\n")
  } else {
    if (facts.tool !== "request_permissions") return undefined
    const reason = typeof input?.reason === "string" ? input.reason.trim() : undefined
    const granted = object(input?.permissions)
    const system = granted?.file_system
    // A file-system rule isn't one this reads back to the screen's wording.
    if (system !== undefined && system !== null) return undefined
    const rule = object(granted?.network)?.enabled === true ? "network" : undefined
    if (reason === undefined && rule === undefined) return undefined
    const shownReason = field(body, "Reason")
    const shownRule = field(body, "Permission rule")
    if (
      reason === undefined
        ? shownReason !== undefined
        : !shownReason || !wrapped(shownReason, reason)
    )
      return undefined
    if (rule === undefined ? shownRule !== undefined : !shownRule || !wrapped(shownRule, rule))
      return undefined
    detail = [rule && `Permission rule: ${rule}`, reason && `Reason: ${collapse(reason)}`]
      .filter((line) => line !== undefined && line !== "")
      .join("\n")
  }

  const { rows, next } = optionsAt(lines, first)
  const footer = lines[next]
  if (rows.length === 0 || (footer !== undefined && !/^\s*Press /.test(footer))) return undefined
  const wordings = titles[name]
  const picks: Choice[] = []
  for (const row of rows) {
    const hinted = /^(.*\S) \(([^()]+)\)$/.exec(row.text)
    const label = hinted?.[1] ?? row.text
    const wording = wordings.find(({ label: pattern }) => pattern.test(label))
    if (!wording) return undefined
    const key = hinted ? keyOf(hinted[2]!) : undefined
    // An option whose shortcut isn't printed, or isn't one to press, can't be answered.
    if (key !== undefined) {
      picks.push({ id: String(row.n), label, key, text: wording.prompt ? "prompt" : null })
    }
  }
  if (picks.length === 0 || new Set(picks.map(({ key }) => key)).size !== picks.length)
    return undefined
  return choose(name, picks, detail)
}

const mcpWordings = [
  { label: "Allow", description: "Run the tool and continue" },
  {
    label: "Allow for this session",
    description: "Run the tool and remember this choice for this session",
  },
  {
    label: "Always allow",
    description: "Run the tool and remember this choice for future tool calls",
  },
  { label: "Cancel", description: "Cancel this tool call" },
] as const

const readMcp = (lines: readonly string[], facts: RequestFacts): Parsed | undefined => {
  if (facts.kind !== "permission" || !facts.tool.startsWith("mcp__")) return undefined
  const form = lastIndex(lines, (line) => /^\s*Field \d+\/\d+\s*$/.test(line))
  const message = lines[form + 1]
  const asked =
    message === undefined ? null : /^\s*(Allow .+ to run tool "(.+)"\?)\s*$/.exec(message)
  if (form < 0 || !asked) return undefined
  const server = /^Allow the (.+) MCP server to run tool/.exec(asked[1]!)?.[1]
  const tool = asked[2]!
  if (!facts.tool.endsWith(`__${tool}`)) return undefined
  if (server !== undefined && facts.tool !== `mcp__${server}__${tool}`) return undefined
  const first = firstOption(lines, form + 2)
  if (first < 0) return undefined
  // The arguments the form prints, one `name: value` line each in name order.
  const given = facts.input === null || facts.input === undefined ? {} : object(facts.input)
  if (!given) return undefined
  const printed = Object.keys(given)
    .toSorted()
    .map((key) => {
      const value = given[key]
      return `${key}: ${typeof value === "string" ? collapse(value) : JSON.stringify(value)}`
    })
  if (!wrapped(lines.slice(form + 2, first), printed.join(" "))) return undefined
  const { rows } = optionsAt(lines, first)
  const known = rows.map((row) => mcpWordings.find(({ label }) => labelled(row.head, label)))
  if (rows.length < 2 || known.some((each) => each === undefined)) return undefined
  // Each row in the order Codex offers them, ending with the cancel.
  const order = known.map((each) => mcpWordings.indexOf(each!))
  if (order.some((at, i) => i > 0 && at <= order[i - 1]!) || order.at(-1) !== 3 || order[0] !== 0) {
    return undefined
  }
  const described = rows.every((row, i) => row.text.includes(known[i]!.description))
  if (!described || rows.length > 9) return undefined
  const picks = rows.map((row, i) => ({
    id: String(row.n),
    label: known[i]!.label,
    key: String(row.n),
    text: null,
  }))
  return choose(asked[1]!, picks, printed.length > 0 ? printed.join("\n") : null)
}

const planTitle = "Implement this plan?"
const planWordings: readonly Wording[] = [
  { label: /^Yes, implement this plan$/ },
  { label: /^Yes, clear context and implement$/ },
  { label: /^No, stay in Plan mode$/, prompt: true },
]

const readPlan = (lines: readonly string[]): Parsed | undefined => {
  const title = lastIndex(lines, (line) => line.trim() === planTitle)
  if (title < 0) return undefined
  const { rows, next } = optionsAt(lines, title + 1)
  if (rows.length !== planWordings.length) return undefined
  // Only the popup at the bottom: its footer is the screen's last row.
  if (next !== lines.length - 1 || !/^\s*\S+ select · \S+ back\s*$/.test(lines[next]!)) {
    return undefined
  }
  const picks: Choice[] = []
  for (const [i, row] of rows.entries()) {
    const wording = planWordings[i]!
    const label = row.head.split("  ")[0]!.trim()
    if (!wording.label.test(label)) return undefined
    picks.push({
      id: String(row.n),
      label,
      key: String(row.n),
      text: wording.prompt ? "prompt" : null,
    })
  }
  return choose(planTitle, picks, null)
}

type Question = {
  readonly id: string
  readonly header: string | null
  readonly question: string
  readonly options: readonly { readonly label: string; readonly description: string | null }[]
}

/** The questions a `request_user_input` call asks, or undefined for any shape not understood. */
const questionsOf = (input: unknown): readonly Question[] | undefined => {
  const list = object(input)?.questions
  if (!Array.isArray(list) || list.length === 0 || list.length > 8) return undefined
  const questions: Question[] = []
  for (const entry of list) {
    const each = object(entry)
    if (!each || typeof each.id !== "string" || typeof each.question !== "string") return undefined
    if (!Array.isArray(each.options) || each.options.length === 0 || each.options.length > 8) {
      return undefined
    }
    const options: Question["options"][number][] = []
    for (const raw of each.options) {
      const option = object(raw)
      if (!option || typeof option.label !== "string" || option.label === "") return undefined
      options.push({
        label: option.label,
        description: typeof option.description === "string" ? option.description : null,
      })
    }
    questions.push({
      id: each.id,
      header: typeof each.header === "string" ? each.header : null,
      question: each.question,
      options,
    })
  }
  return new Set(questions.map(({ id }) => id)).size === questions.length ? questions : undefined
}

const otherLabel = "None of the above"
const questionHeader = /^\s*Question (\d+)\/(\d+)(?: \(\d+ unanswered\))?$/

/** The line of the screen's question header and the question it is on, or undefined. */
const headerOf = (
  lines: readonly string[],
): { readonly at: number; readonly k: number; readonly of: number } | undefined => {
  const at = lastIndex(lines, (line) => questionHeader.test(line))
  const found = at < 0 ? null : questionHeader.exec(lines[at]!)
  return found ? { at, k: Number(found[1]), of: Number(found[2]) } : undefined
}

/** Whether the screen shows question `k` (from 0) of `questions`, its text under its header. */
const showing = (rows: readonly string[], questions: readonly Question[], k: number): boolean => {
  const lines = clean(rows)
  const header = headerOf(lines)
  if (header?.k !== k + 1 || header.of !== questions.length) return false
  const first = firstOption(lines, header.at + 1)
  if (first < 0) return false
  if (squash(lines.slice(header.at + 1, first).join("")) !== squash(questions[k]!.question)) {
    return false
  }
  // Its options as the request lists them, in order, with the notes closed: a digit then
  // picks the row the answer means.
  const shown = optionsAt(lines, first)
  const { next } = shown
  const options = shown.rows
  const count = questions[k]!.options.length
  if (options.length !== count && options.length !== count + 1) return false
  if (!questions[k]!.options.every((option, i) => labelled(options[i]!.head, option.label))) {
    return false
  }
  if (options.length > count && !labelled(options[count]!.head, otherLabel)) return false
  return !lines.slice(next).some((line) => /^\s*›/.test(line) || /clear notes/.test(line))
}

/**
 * Whether the notes field's own row, the `›` line under the options, starts with the words
 * (their first characters, as the field shows what fits): not any other row.
 */
const notesStart = (rows: readonly string[], text: string): boolean => {
  const lines = clean(rows)
  const top = headerOf(lines)
  const first = top ? firstOption(lines, top.at + 1) : -1
  if (first < 0) return false
  const { next } = optionsAt(lines, first)
  const end = lines.findIndex((line, at) => at >= next && /clear notes/.test(line))
  if (end < 0 || !/^\s*›/.test(lines[next] ?? "")) return false
  const typed = squash(lines.slice(next, end).join("")).replace(/^›/, "")
  return typed.startsWith(squash(text).slice(0, 40))
}

const readQuestions = (lines: readonly string[], facts: RequestFacts): Parsed | undefined => {
  if (facts.kind !== "question" || facts.tool !== "request_user_input") return undefined
  const questions = questionsOf(facts.input)
  const header = headerOf(lines)
  if (!questions || header?.k !== 1 || header.of !== questions.length) return undefined
  const first = firstOption(lines, header.at + 1)
  if (first < 0) return undefined
  const [question] = questions
  if (squash(lines.slice(header.at + 1, first).join("")) !== squash(question!.question)) {
    return undefined
  }
  const { rows, next } = optionsAt(lines, first)
  const count = question!.options.length
  const other = rows.length === count + 1
  if (rows.length !== count && !other) return undefined
  if (!question!.options.every((option, i) => labelled(rows[i]!.head, option.label)))
    return undefined
  if (other && !labelled(rows[count]!.head, otherLabel)) return undefined
  // Words already typed in its notes, or anything else after the options, is not a screen
  // whose digits answer.
  if (lines.slice(next).some((line) => /^\s*›/.test(line) || /clear notes/.test(line))) {
    return undefined
  }
  const highlighted = Math.max(
    0,
    rows.findIndex((row) => row.marked),
  )

  return {
    dialog: {
      type: "questions",
      // Esc abandons the call and interrupts the turn: the person's words then go as the
      // next prompt, which the model sees after "aborted by user" (probed 0.159.3).
      chat: "prompt",
      questions: questions.map((each) => ({
        id: each.id,
        header: each.header,
        question: each.question,
        options: each.options.map(({ label, description }, i) => ({
          id: String(i + 1),
          label,
          description,
        })),
        multiSelect: false,
        // Only the first question's rows are on screen to read; a later one's aren't
        // vouched for, so it takes no words.
        text: other && each === questions[0],
      })),
    },
    keys: (answer) => {
      if (answer.type === "chat") return [{ press: "\x1b" }]
      if (answer.type !== "questions" || answer.answers.length !== questions.length)
        return undefined
      const steps: KeyStep[] = []
      for (const [k, each] of questions.entries()) {
        const given = answer.answers.filter(({ question: id }) => id === each.id)
        if (given.length !== 1) return undefined
        const { options, text } = given[0]!
        if (options.length > 1 || (options.length === 0 && text === undefined)) return undefined
        if (text !== undefined && !(other && k === 0)) return undefined
        const picked =
          options[0] === undefined
            ? undefined
            : each.options.findIndex((_, i) => String(i + 1) === options[0])
        if (picked === -1) return undefined
        if (k > 0) {
          steps.push({
            until: (screen) => showing(screen, questions, k),
            timeoutMs: 5000,
            why: `question ${k + 1} of ${questions.length}`,
          })
        }
        if (text === undefined) {
          steps.push({ press: String(picked! + 1) })
          continue
        }
        // Words go in the notes of the row they belong to; a digit would submit instead.
        const target = picked ?? each.options.length
        const from = k === 0 ? highlighted : 0
        const move = target > from ? "\x1b[B" : "\x1b[A"
        for (let step = 0; step < Math.abs(target - from); step += 1) steps.push({ press: move })
        steps.push({
          until: (screen) => {
            const shown = clean(screen)
            const top = headerOf(shown)
            const marked = top ? optionsAt(shown, firstOption(shown, top.at + 1)).rows : []
            return marked.findIndex((row) => row.marked) === target
          },
          timeoutMs: 5000,
          why: "the row for the words highlighted",
        })
        steps.push({ press: "\t" })
        steps.push({
          until: (screen) => screen.some((line) => /clear notes/.test(line)),
          timeoutMs: 5000,
          why: "the notes field open",
        })
        steps.push({ type: text })
        steps.push({
          until: (screen) => notesStart(screen, text),
          timeoutMs: 5000,
          why: "the words in the notes field",
        })
        steps.push({ press: "\r" })
      }
      return steps
    },
  }
}

// The lines Codex leaves in its history once a dialog is answered.
const resulted =
  /^\s*(?:[✔✗] You |• Questions? \d+\/\d+ answered|You (?:granted|did not grant|denied|declined)\b)/

const marks = (rows: readonly string[]): number =>
  clean(rows).filter((line) => resulted.test(line)).length

/** Whether the composer's footer is drawn at the bottom: no dialog covers it. */
const composerShown = (rows: readonly string[]): boolean =>
  clean(rows)
    .slice(-3)
    .some((line) => /\? for shortcuts|· (?:\/|~|[A-Za-z]:\\)/.test(line))

const parse = (rows: readonly string[], facts: RequestFacts): Parsed | undefined => {
  const lines = clean(rows)
  if (facts.kind === "question") return readQuestions(lines, facts)
  if (facts.kind === "plan") return readPlan(lines)
  return readMcp(lines, facts) ?? readApproval(lines, facts)
}

export const dialogs: DialogAdapter = {
  read: (rows, request): DialogRead | undefined => {
    const parsed = parse(rows, request)
    if (!parsed) return undefined
    return {
      ...parsed,
      // Gone: the dialog this request asked is no longer the one on screen (a queued
      // request's takes its place with its own command, or the answer's line took it).
      answered: (later) =>
        marks(later) > marks(rows) || (parse(later, request) === undefined && composerShown(later)),
    }
  },
  screenRequest: (rows): ScreenRequest | undefined =>
    readPlan(clean(rows)) === undefined
      ? undefined
      : { kind: "plan", tool: "plan", input: null, subject: planTitle },
}
