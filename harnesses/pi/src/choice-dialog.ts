import { refuse } from "@novadeck/harness-core/dialogs"
import type {
  AnswerableDialog,
  DialogRead,
  KeyStep,
  RequestFacts,
} from "@novadeck/harness-core/dialogs"

import {
  blockOf,
  enter,
  messageOf,
  moves,
  only,
  optionsOf,
  selectHint,
  squash,
  timeoutMs,
  titleOf,
  widthOf,
} from "./dialog-screen.js"

/**
 * pi's selects and confirms (probed 2026-11-24, 1.6.0; fixtures/dialogs.probe.json): an
 * extension's select (`ctx.ui.select`) and confirm (`ctx.ui.confirm`), and the trust prompt pi
 * draws as it starts. Each is a heading (a title, a confirm's message, the trust prompt's folder
 * and why) over options, `→ ` before the selected one, then `↑↓ navigate  enter select
 * escape/ctrl+c cancel`. Down and Up move the selection a row each, with no wrap at either end,
 * and Enter picks it; Escape cancels, which nothing here presses.
 */

type Choice = {
  /** The title's rows, and a confirm's message under it, as read. */
  readonly heading: string
  readonly labels: readonly string[]
  readonly selected: number
}

/** A select or a confirm on screen: its heading (title and message) and its options. */
const choiceOf = (rows: readonly string[]): Choice | undefined => {
  const block = blockOf(rows, selectHint)
  if (!block) return refuse("choice.choiceOf.1")
  const options = optionsOf(block.lines, widthOf(rows))
  if (!options) return refuse("choice.choiceOf.2")
  const heading = block.lines
    .slice(0, options.from)
    .map((line) => line.replace(/^ /, ""))
    .join("\n")
    .trim()
  if (heading === "") return refuse("choice.choiceOf.3")
  return { heading, labels: options.labels, selected: options.selected }
}

/** Whether a later screen shows a select or confirm under `heading` still. */
const stillShows = (rows: readonly string[], heading: string): boolean =>
  squash(choiceOf(rows)?.heading ?? "") === squash(heading)

/** The keys that pick option `to` of a list whose selection is at `from`, then a wait to see it. */
const pick = (heading: string, from: number, to: number): KeyStep[] => [
  ...(from === to ? [] : [{ press: moves(from, to) }]),
  {
    until: (rows) => {
      const now = choiceOf(rows)
      return now !== undefined && squash(now.heading) === squash(heading) && now.selected === to
    },
    timeoutMs,
    why: `option ${to + 1} selected`,
  },
  { press: enter },
]

/** An extension's select: one question, its options as the screen lists them. */
export const select = (rows: readonly string[], request: RequestFacts): DialogRead | undefined => {
  const title = titleOf(request.input)
  if (title === undefined) return refuse("select.select.1")
  const now = choiceOf(rows)
  if (!now || squash(now.heading) !== squash(title)) return refuse("select.select.2")
  const dialog: AnswerableDialog = {
    type: "questions",
    questions: [
      {
        id: "1",
        header: null,
        question: title,
        options: now.labels.map((label, at) => ({ id: String(at + 1), label, description: null })),
        multiSelect: false,
        text: false,
      },
    ],
    // Set aside, its Escape gives the extension nothing; what the person says then is theirs to
    // send, not Novadeck's to guess where.
    chat: null,
  }
  return {
    dialog,
    keys: (answer) => {
      if (answer.type !== "questions" || answer.answers.length !== 1) return undefined
      const [given] = answer.answers
      if (!given || given.question !== "1" || given.text !== undefined) return undefined
      const picked = only(given.options)
      const to = picked === undefined ? Number.NaN : Number(picked) - 1
      if (!Number.isInteger(to) || to < 0 || to >= now.labels.length) return undefined
      return pick(now.heading, now.selected, to)
    },
    answered: (later) => !stillShows(later, now.heading),
  }
}

/** An extension's confirm: Yes or No under its title and message. */
export const confirm = (rows: readonly string[], request: RequestFacts): DialogRead | undefined => {
  const title = titleOf(request.input)
  if (title === undefined) return refuse("confirm.confirm.1")
  const now = choiceOf(rows)
  if (!now || now.labels.join("|") !== "Yes|No") return refuse("confirm.confirm.2")
  // Its title's rows, then its message's: the request's message, where it names one.
  const shown = now.heading.split("\n")
  const titleRows = shown.findIndex(
    (_, at) => squash(shown.slice(0, at + 1).join("")) === squash(title),
  )
  if (titleRows < 0) return refuse("confirm.confirm.3")
  const message = messageOf(request.input)
  const detail = shown
    .slice(titleRows + 1)
    .join("\n")
    .trim()
  if (message !== undefined && squash(detail) !== squash(message))
    return refuse("confirm.confirm.4")
  const dialog: AnswerableDialog = {
    type: "choices",
    title,
    detail: detail === "" ? null : detail,
    options: [
      { id: "yes", label: "Yes", text: null },
      { id: "no", label: "No", text: null },
    ],
  }
  return {
    dialog,
    keys: (answer) => {
      if (answer.type !== "choice" || answer.text !== undefined) return undefined
      const to = answer.option === "yes" ? 0 : answer.option === "no" ? 1 : -1
      return to < 0 ? undefined : pick(now.heading, now.selected, to)
    },
    answered: (later) => !stillShows(later, now.heading),
  }
}

// --- The trust prompt -------------------------------------------------------------------------

export const trustTitle = "Trust project folder?"

/** The trust prompt, on the normal screen before pi's TUI: its folder, why, and five options. */
export const trustOf = (
  rows: readonly string[],
): (Choice & { readonly folder: string }) | undefined => {
  const now = choiceOf(rows)
  if (!now) return refuse("trust.trustOf.1")
  const [title, folder] = now.heading.split("\n")
  if (title?.trim() !== trustTitle || folder === undefined || folder.trim() === "")
    return refuse("trust.trustOf.2")
  if (now.labels.length !== 5 || !now.labels[0]!.startsWith("Trust"))
    return refuse("trust.trustOf.3")
  return { ...now, folder: folder.trim() }
}

export const trust = (rows: readonly string[], request: RequestFacts): DialogRead | undefined => {
  const now = trustOf(rows)
  if (!now) return refuse("trust.trust.1")
  const { folder } = (request.input ?? {}) as { folder?: unknown }
  if (folder !== now.folder) return refuse("trust.trust.2")
  const why = now.heading.split("\n").slice(2).join("\n").trim()
  const dialog: AnswerableDialog = {
    type: "choices",
    title: trustTitle,
    detail: why === "" ? now.folder : `${now.folder}\n\n${why}`,
    options: now.labels.map((label, at) => ({ id: String(at + 1), label, text: null })),
  }
  return {
    dialog,
    keys: (answer) => {
      if (answer.type !== "choice" || answer.text !== undefined) return undefined
      const to = Number(answer.option) - 1
      if (!Number.isInteger(to) || to < 0 || to >= now.labels.length) return undefined
      return pick(now.heading, now.selected, to)
    },
    answered: (later) => trustOf(later) === undefined,
  }
}
