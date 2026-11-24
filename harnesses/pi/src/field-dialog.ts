import { refuse } from "@novadeck/harness-core/dialogs"
import type { AnswerableDialog, DialogRead, RequestFacts } from "@novadeck/harness-core/dialogs"
import type { RequestAnswer } from "@novadeck/protocol"

import {
  blockOf,
  editorHint,
  enter,
  inputHint,
  ruleRow,
  shows,
  squash,
  timeoutMs,
  titleOf,
  typeable,
  writable,
} from "./dialog-screen.js"

/**
 * pi's fields (probed 2026-11-24, 1.6.0; fixtures/dialogs.probe.json): an extension's input
 * (`ctx.ui.input`), its title over `>` and what was typed, then `enter submit
 * escape/ctrl+c cancel`; and its editor (`ctx.ui.editor`), its title over a box of its own between
 * rules, holding the text it was given, then `enter submit  shift+enter/ctrl+j newline …`. A
 * bracketed paste goes into either as text, and Enter submits it.
 */

type Field = { readonly title: string; readonly text: string }

/** An input on screen: its title, then its field, `>` and what was typed. */
const inputOf = (rows: readonly string[]): Field | undefined => {
  const block = blockOf(rows, inputHint)
  if (!block) return refuse("input.inputOf.1")
  const lines = block.lines.filter((line) => line.trim() !== "")
  const field = lines.at(-1)
  if (field === undefined || !/^>(?: |$)/.test(field)) return refuse("input.inputOf.2")
  const title = lines
    .slice(0, -1)
    .map((line) => line.replace(/^ /, ""))
    .join("\n")
    .trim()
  return title === "" ? refuse("input.inputOf.3") : { title, text: field.slice(2).trim() }
}

/** An editor on screen: its title, then its own box between rules, holding its text. */
const editorOf = (rows: readonly string[]): Field | undefined => {
  const block = blockOf(rows, editorHint, true)
  if (!block) return refuse("editor.editorOf.1")
  const rules = block.lines.flatMap((line, at) => (ruleRow(line) ? [at] : []))
  if (rules.length !== 2) return refuse("editor.editorOf.2")
  const [open, close] = rules as [number, number]
  if (block.lines.slice(close + 1).some((line) => line.trim() !== ""))
    return refuse("editor.editorOf.3")
  const title = block.lines
    .slice(0, open)
    .map((line) => line.replace(/^ /, ""))
    .join("\n")
    .trim()
  if (title === "") return refuse("editor.editorOf.4")
  return { title, text: block.lines.slice(open + 1, close).join("\n") }
}

/** A field's dialog: one question answered in the person's words. */
const fieldDialog = (title: string): AnswerableDialog => ({
  type: "questions",
  questions: [
    { id: "1", header: null, question: title, options: [], multiSelect: false, text: true },
  ],
  chat: null,
})

/** The words an answer gives a field's one question, where it gives only words. */
const wordsOf = (answer: RequestAnswer): string | undefined => {
  const given =
    answer.type === "questions" && answer.answers.length === 1 ? answer.answers[0] : undefined
  return given?.question === "1" && given.options.length === 0 ? given.text : undefined
}

/** An extension's input: the words pasted into its empty field, seen there, then Enter. */
export const input = (rows: readonly string[], request: RequestFacts): DialogRead | undefined => {
  const title = titleOf(request.input)
  if (title === undefined) return refuse("input.input.1")
  const now = inputOf(rows)
  if (!now || squash(now.title) !== squash(title)) return refuse("input.input.2")
  const field = (later: readonly string[]): string | undefined => {
    const shown = inputOf(later)
    return shown && squash(shown.title) === squash(title) ? shown.text : undefined
  }
  return {
    dialog: fieldDialog(title),
    keys: (answer) => {
      const words = wordsOf(answer)
      // Only into an empty field: what the person typed there is theirs.
      if (words === undefined || !typeable(words) || squash(words) === "" || now.text !== "")
        return undefined
      return [{ type: words }, shows(words, field, "its words in the field"), { press: enter }]
    },
    answered: (later) => field(later) === undefined,
  }
}

/**
 * An extension's editor: the text it was given emptied with its editor's keys (Down to its last
 * line, then Ctrl-E and Ctrl-U twice a line, as in the input box), the words pasted, seen, then
 * Enter (probed 2026-11-24, 1.6.0, `editorErased`, `editorTyped`, `editorDone` of
 * fixtures/dialogs.probe.json).
 */
export const editor = (rows: readonly string[], request: RequestFacts): DialogRead | undefined => {
  const title = titleOf(request.input)
  if (title === undefined) return refuse("editor.editor.1")
  const now = editorOf(rows)
  if (!now || squash(now.title) !== squash(title)) return refuse("editor.editor.2")
  const field = (later: readonly string[]): string | undefined => {
    const shown = editorOf(later)
    return shown && squash(shown.title) === squash(title) ? shown.text : undefined
  }
  const lines = now.text.split("\n").length
  return {
    dialog: fieldDialog(title),
    keys: (answer) => {
      const words = wordsOf(answer)
      if (words === undefined || !writable(words) || squash(words) === "") return undefined
      return [
        { press: `${"\x1b[B".repeat(lines - 1)}${"\x05\x15\x15".repeat(lines)}` },
        {
          until: (later) => squash(field(later) ?? "x") === "",
          timeoutMs,
          why: "its text emptied",
        },
        { type: words },
        shows(words, field, "its words in the editor"),
        { press: enter },
      ]
    },
    answered: (later) => field(later) === undefined,
  }
}
