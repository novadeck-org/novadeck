import { askToFixNudge } from "@novadeck/core/agents/steps"
import type { ChatAnswer, ChatRequest } from "@novadeck/core/conversation"
import { optionExtras } from "@novadeck/core/conversation/extras"
import type { AskOption, InboxAnswer, InboxRow, Trouble } from "@novadeck/core/inbox"

import { actionOf, agentName, clock, recommended, waitLabel } from "./inbox-text"

// The numbered menu a sheet answers its own kinds with (an agent's ask, a held message, trouble,
// an update): each menu row's words, the line under it where that says what the row's words
// don't, and what it sends with the receipt the next sheet shows for it. A request is answered
// by its card (@novadeck/requests), as in the chat, and `requestReceipt` says what its answer
// did. Pure, so the rules read apart from the markup.

// A menu row's own text: its label as the harness or agent wrote it (`code` between backticks).
export type MenuRow =
  | {
      readonly type: "answer"
      readonly label: string
      readonly effect: string | null
      // The agent's own pick.
      readonly pick: boolean
      // More about an option, shown while the cursor is on it.
      readonly details: Pick<AskOption, "details" | "code"> | null
      readonly answer: InboxAnswer
      readonly receipt: string
      // Hard to take back: the first press arms the row, the second sends.
      readonly hard?: true
      // Shows the agent's terminal once it has answered, as a follow-up does.
      readonly reveal?: true
    }
  // The row that becomes a box for the person's words, in place. `required` where an
  // empty box sends nothing; else the empty box sends `answer("")`.
  | {
      readonly type: "words"
      readonly label: string
      readonly placeholder: string
      readonly field: string
      readonly required: boolean
      readonly answer: (text: string) => InboxAnswer
      readonly receipt: (text: string) => string
      // Why these words won't go, said before they're sent; null where they will.
      readonly refused: (text: string) => string | null
    }
  // Shows the terminal: what can't be answered from here.
  | { readonly type: "reveal"; readonly label: string; readonly effect: string | null }
  // Changes how the Inbox row is handled, without answering it: it stays.
  | {
      readonly type: "toggle"
      readonly label: string
      readonly on: boolean
      readonly change: InboxAnswer
    }

export type Menu = {
  readonly rows: readonly MenuRow[]
  // Whether an answer is hard to take back: the first press arms it, the second sends.
  readonly hard: boolean
}

// The way to the row's terminal.
const goToTerminal: MenuRow = { type: "reveal", label: "Go to terminal", effect: null }

// Every menu ends on the way to the row's terminal, where it has none of its own.
const withTerminal = (menu: Menu): Menu =>
  menu.rows.some((row) => row.type === "reveal")
    ? menu
    : { ...menu, rows: [...menu.rows, goToTerminal] }

// What a permission is for, as a receipt names it: "@crow's command".
const thing = (request: ChatRequest): string => {
  const action = actionOf(request)
  if (action === "plan") return "plan"
  if (action === "run") return "command"
  if (action === "edit") return "edit"
  return request.tool
}

// The receipt the next sheet shows for an answer to a request, as its card sent it: what the
// option the person took did, by the role core reads into it (`conversation/extras`), with the
// harness's own label left as it is on the card.
export const requestReceipt = (
  request: ChatRequest,
  handle: string,
  answer: ChatAnswer,
): string => {
  const who = `@${handle}'s ${thing(request)}`
  const plan = actionOf(request) === "plan"
  const { dialog } = request
  switch (answer.type) {
    case "questions": {
      const several = dialog?.type === "questions" && dialog.questions.length > 1
      return `Answered @${handle}'s ${several ? "questions" : "question"}.`
    }
    case "chat":
      return `Set @${handle}'s questions aside to talk them over in its terminal.`
    case "form":
      return answer.action === "accept"
        ? `Filled in @${handle}'s form.`
        : `Declined @${handle}'s form.`
    case "choice": {
      const options = dialog?.type === "choices" ? dialog.options : []
      const at = options.findIndex((option) => option.id === answer.option)
      const role = at === -1 ? "other" : optionExtras(request.kind, options)[at]!.role
      const words = answer.text?.trim() ? ", with your words" : ""
      if (role === "yes") return `${plan ? "Approved" : "Allowed"} ${who}${words}.`
      if (role === "standing") return `${plan ? "Approved" : "Allowed"} ${who}; it won't ask again.`
      if (role === "no" || role === "words")
        return `${plan ? "Sent back" : "Denied"} ${who}${words}.`
      return `Answered ${who}${words}.`
    }
  }
}

// What the person may write in place of an agent's options, or as its answer.
const ownWords = (row: InboxRow, label = "Reply in your own words"): MenuRow => ({
  type: "words",
  label,
  placeholder: `Reply to ${agentName(row.source.agent)}`,
  field: `Reply to ${agentName(row.source.agent)}`,
  required: true,
  answer: (text) => ({ kind: "ask", answer: { type: "reply", option: null, text: text.trim() } }),
  receipt: () => `Reply queued for @${row.source.handle}.`,
  refused: () => null,
})

const askMenu = (row: Extract<InboxRow, { kind: "ask" }>): Menu => {
  const { ask, source } = row
  const { shape } = ask
  const hard = ask.hardToUndo !== null
  if (shape.type === "text") return { rows: [ownWords(row, "Reply")], hard }
  if (shape.type === "action")
    return {
      rows: [
        {
          type: "answer",
          label: shape.doneLabel,
          effect: null,
          pick: false,
          details: null,
          answer: { kind: "ask", answer: { type: "done" } },
          receipt: `Told @${source.handle} it's done.`,
        },
        ownWords(row),
      ],
      hard,
    }
  return {
    rows: [
      ...shape.options.map((option, index): MenuRow => {
        const { label, pick } = recommended(option.label)
        return {
          type: "answer",
          label,
          effect: option.summary,
          pick: pick || shape.recommend === index,
          details: option.details || option.code ? option : null,
          answer: { kind: "ask", answer: { type: "reply", option: index, text: "" } },
          receipt: `Reply queued for @${source.handle}.`,
        }
      }),
      ownWords(row),
    ],
    hard,
  }
}

// What "Ask it to fix" sends, as core knows it, so the agent's context never quotes it as the
// person's words.
const fix = askToFixNudge

// A trouble's answer row.
const troubleRow = (
  label: string,
  action: Extract<InboxAnswer, { kind: "trouble" }>["action"],
  receipt: string,
  effect: string | null = null,
): MenuRow => ({
  type: "answer",
  label,
  effect,
  pick: false,
  details: null,
  answer: { kind: "trouble", action },
  receipt,
})

const troubleMenu = (row: InboxRow, trouble: Trouble, now: number): Menu => {
  const { handle } = row.source
  switch (trouble.type) {
    case "failed":
      return {
        rows: row.stopped
          ? [
              troubleRow(
                "Ask it to fix",
                { type: "nudge", text: fix },
                `Asked @${handle} to fix it.`,
                `Sends: “${fix}”`,
              ),
            ]
          : [],
        hard: false,
      }
    case "stuck":
      return {
        rows: [
          troubleRow(
            "Nudge it",
            { type: "nudge", text: trouble.nudge },
            `Nudged @${handle}.`,
            `Stops what it's doing and sends: “${trouble.nudge}”`,
          ),
          {
            type: "words",
            label: "Nudge it in your own words",
            placeholder: "What should it try?",
            field: `What ${agentName(row.source.agent)} should try`,
            required: true,
            answer: (text) => ({
              kind: "trouble",
              action: { type: "nudge", text: text.trim(), own: true },
            }),
            receipt: () => `Nudged @${handle} with your words.`,
            refused: () => null,
          },
          troubleRow("Stop it", { type: "stop" }, `Stopped @${handle}.`),
        ],
        hard: false,
      }
    case "limit": {
      const rows: MenuRow[] = []
      if (trouble.autoResume !== null)
        rows.push({
          type: "toggle",
          label: `Resume automatically at ${clock(trouble.resetsAt)}`,
          on: trouble.autoResume,
          change: { kind: "trouble", action: { type: "auto-resume", on: !trouble.autoResume } },
        })
      if (!trouble.autoResume && trouble.resetsAt <= now)
        rows.push(
          troubleRow(
            "Continue now",
            { type: "continue" },
            `Told @${handle} to continue.`,
            "Sends “continue” as its next prompt.",
          ),
        )
      return { rows, hard: false }
    }
    case "waits":
      return {
        rows: [{ type: "reveal", label: "Show terminal", effect: null }],
        hard: false,
      }
  }
}

// The rows a sheet draws as its own, every kind but a request, which its card answers.
export type OwnRow = Exclude<InboxRow, { readonly kind: "request" }>

// The menu of a row of the Inbox's own, at `now`: a limit's reset is read against it.
export const menuOf = (row: OwnRow, now: number): Menu => withTerminal(answersOf(row, now))

const answersOf = (row: OwnRow, now: number): Menu => {
  switch (row.kind) {
    case "held": {
      const { from, to } = row.held
      return {
        rows: [
          {
            type: "answer",
            label: "Release",
            effect: `${to.title} gets it.`,
            pick: false,
            details: null,
            answer: { kind: "held", action: "release" },
            receipt: `Released @${from.handle}'s message to @${to.handle}.`,
          },
          {
            type: "answer",
            label: "Stop this thread",
            effect: null,
            pick: false,
            details: null,
            answer: { kind: "held", action: "stop" },
            receipt: `Stopped the thread between @${from.handle} and @${to.handle}.`,
          },
        ],
        hard: false,
      }
    }
    case "ask":
      return askMenu(row)
    case "trouble":
      return troubleMenu(row, row.trouble, now)
    case "update":
      // Opening it read it: all that is left to do is to answer in the terminal.
      return { rows: [], hard: false }
  }
}

// When a limit resets, said as a sentence: "at 14:00, in 1h 12m", or that it has.
export const resetLabel = (resetsAt: number, now: number): string =>
  resetsAt <= now
    ? `reset at ${clock(resetsAt)}`
    : `resets at ${clock(resetsAt)}, in ${waitLabel(now, resetsAt)}`
