import type { AnswerableDialog, DialogRead, KeyStep } from "@novadeck/harness-core/dialogs"
import { isFields, type Fields } from "@novadeck/harness-core/tools"
import type { RequestAnswer } from "@novadeck/protocol"

/**
 * What Claude Code's dialogs share on screen (see `dialogs.ts`): the keys that answer them,
 * the rules and option rows they draw, and its input box, whose return says one is gone.
 */

export const Right = "\x1b[C"
export const Down = "\x1b[B"
export const Up = "\x1b[A"
export const Enter = "\r"

/** How long a step waits for the screen to show what the next one needs. */
export const timeoutMs = 3000

/** Text without whitespace and the quote bars, so that wrapping never matters. */
export const flat = (text: string): string => text.replace(/[\s│]+/g, "")

export const rule = /^─+$/
export const dashed = /^╌+$/

/** A JSON object's fields, as a request's input holds them; undefined for anything else. */
export const fieldsOf = (value: unknown): Fields | undefined =>
  isFields(value) ? value : undefined

/** A string with something in it but blanks. */
export const nonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

// Words the person types into a field: one line, as the field takes them.
// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
export const typeable = (text: string): boolean => !/[\x00-\x1f\x7f]/.test(text)

/** The key that picks option `n`, which only one digit reaches. */
export const digit = (n: number): string | undefined => (n >= 1 && n <= 9 ? String(n) : undefined)

/** Whether the options' marker sits on row `n`, as a field opening there leaves it. */
export const marked = (rows: readonly string[], row: RegExp, n: number): boolean =>
  rows.some((each) => {
    const match = row.exec(each)
    return match?.[1] === "❯" && Number(match[2]) === n
  })

/**
 * Whether row `n`, highlighted, now starts with `text` (as far as a row shows it): the
 * field's own row, where words typed into it appear, and no other row.
 */
export const landed = (
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

// The hint for ctrl+g, which names the editor it opens: Vim, unless EDITOR or VISUAL names
// another, and Notepad on Windows (2.1.287). On a row as shown, and with its spaces gone.
export const editorHint = /ctrl\+g to edit in \S/
export const editorHintFlat = /^ctrl\+gtoeditin[^·]+·/

/**
 * Whether Claude Code's own input box shows, between its rules above the status row: it
 * hides while a dialog is up, so its return is the positive sign a dialog is gone.
 */
export const idle = (rows: readonly string[]): boolean =>
  rows.some((each, at) => {
    if (!each.startsWith("❯") || at === 0) return false
    const before = rows.slice(0, at).findLastIndex((row) => row !== "")
    const after = rows.findIndex((row, index) => index > at && row !== "")
    return before >= 0 && rule.test(rows[before]!) && after >= 0 && rule.test(rows[after]!)
  })

type Option = { readonly n: number; readonly marker: boolean; readonly label: string }

/**
 * Numbered option rows from `from` on, each with its wrapped continuation rows, in the
 * layout `row` reads; what follows them is returned as `rest`. Undefined unless they
 * number 1, 2, … and exactly one is highlighted.
 */
export const numbered = (
  rows: readonly string[],
  from: number,
  row: RegExp,
  continuation: RegExp,
  hint?: RegExp,
): { options: Option[]; rest: string[] } | undefined => {
  const options: Option[] = []
  let index = from
  for (; index < rows.length; index++) {
    const text = rows[index]!
    // The screen leaves blank rows between a dialog's parts.
    if (text === "") continue
    const match = row.exec(text)
    if (match) {
      options.push({ n: Number(match[2]), marker: match[1] === "❯", label: match[3]!.trim() })
    } else if (options.length > 0 && continuation.test(text)) {
      const each = options.pop()!
      options.push({ ...each, label: `${each.label} ${text.trim()}` })
    } else if (options.length > 0 && hint?.test(text)) {
      continue
    } else break
  }
  const rest = rows.slice(index).filter((each) => each !== "")
  const highlighted = options.filter(({ marker }) => marker).length
  if (options.length < 2 || highlighted !== 1) return undefined
  if (options.some(({ n }, at) => n !== at + 1)) return undefined
  return { options, rest }
}

/** A `choices` dialog, read from its numbered options. */
type Choices = {
  readonly title: string
  readonly detail: string | null
  readonly options: readonly Option[]
  /** The steps that pick `option`, given the answer; undefined where it can't take it. */
  readonly keys: (
    option: Option,
    answer: RequestAnswer & { type: "choice" },
  ) => readonly KeyStep[] | undefined
  readonly answered: (rows: readonly string[]) => boolean
  /** The option that opens a field for the person's words. */
  readonly field?: number
  /** Options whose words go as the next prompt, once the option is chosen. */
  readonly prompts?: ReadonlySet<number>
  /** Options the screen doesn't have, each a prompt option that presses one it does. */
  readonly emulated?: readonly { id: string; label: string; presses: number }[]
}

export const choices = ({
  title,
  detail,
  options,
  keys,
  answered,
  field,
  prompts = new Set(),
  emulated = [],
}: Choices): DialogRead => {
  const dialog: AnswerableDialog = {
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

/** The keys of an option a digit picks at once, which take no words. */
export const digitKeys: Choices["keys"] = ({ n }, answer) => {
  const key = digit(n)
  return key && answer.text === undefined ? [{ press: key }] : undefined
}

/** Rows' text as the dialog quotes it: without the quote bar a command's rows carry. */
export const quoted = (rows: readonly string[]): string[] =>
  rows.filter((each) => each !== "").map((each) => each.replace(/^ ?(?:│(?: |$))?/, "").trimEnd())

/**
 * Whether `rows` are `expected` as the terminal wrapped it: whitespace collapsed (never
 * stripped), a row break standing for a space where the text has one and for none where
 * it broke a word.
 */
export const wraps = (rows: readonly string[], expected: string): boolean => {
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

/** The ╌-ruled block above `from`: its rows, and the row of its opening rule. */
export const ruled = (
  rows: readonly string[],
  from: number,
): { body: readonly string[]; open: number } | undefined => {
  const close = rows.slice(0, from).findLastIndex((each) => dashed.test(each))
  if (close < 1) return undefined
  const open = rows.slice(0, close).findLastIndex((each) => dashed.test(each))
  if (open < 1) return undefined
  return { body: rows.slice(open + 1, close), open }
}

/**
 * A step's wait that holds only once the screen has shown its test for `ms`: for a dialog
 * that handles a key against what it drew before, until it redraws, so a highlight that
 * only just arrived is not yet one a key lands on (see `form-dialog.ts`).
 */
export const settled = (test: (rows: readonly string[]) => boolean, ms = 400) => {
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
