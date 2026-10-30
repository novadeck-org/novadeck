import { askToFixNudge } from "@novadeck/core/agents/steps"
import type { ChatAnswer, ChatDialogOption, ChatRequest } from "@novadeck/core/conversation"
import type { AskOption, InboxAnswer, InboxRow, Trouble } from "@novadeck/core/inbox"

import {
  actionOf,
  agentName,
  choicesOf,
  clock,
  needsWords,
  recommended,
  refusedWords,
  setsStanding,
  waitLabel,
} from "./inbox-text"

// The numbered menu a sheet answers with, by kind: each row's words, the line under it where
// that says what the row's words don't, and what it sends with the receipt the next sheet
// shows for it. Pure, so the rules read apart from the markup. An agent's own questions
// take their picks as they go and are made in `QuestionsMenu`.

// A row's own text: its label as the harness or agent wrote it (`code` between backticks).
export type Row =
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
  // Changes how the item is handled, without answering it: it stays.
  | {
      readonly type: "toggle"
      readonly label: string
      readonly on: boolean
      readonly change: InboxAnswer
    }

export type Menu = {
  readonly rows: readonly Row[]
  // Whether an answer is hard to take back: the first press arms it, the second sends.
  readonly hard: boolean
}

const none: Menu = { rows: [], hard: false }

// The way to an item's terminal.
const goToTerminal: Row = { type: "reveal", label: "Go to terminal", effect: null }

// A prompt that can't be answered from here: the way to its terminal.
const inTerminal: Menu = { rows: [goToTerminal], hard: false }

// Every menu ends on the way to the item's terminal, where it has none of its own.
const withTerminal = (menu: Menu): Menu =>
  menu.rows.some((row) => row.type === "reveal")
    ? menu
    : { ...menu, rows: [...menu.rows, goToTerminal] }

// Whether the sheet can answer a request: its dialog read, and its options ones the menu
// can tell apart (a yes among them). Every other item it can.
export const answerable = (item: InboxRow): boolean => {
  if (item.kind !== "request") return true
  const { dialog } = item.request
  if (dialog?.type === "questions") return true
  return dialog?.type === "choices" && choicesOf(dialog.options) !== null
}

// A field takes one line, so the words' line breaks (and other control characters) go as
// spaces.
const choiceAnswer = (dialog: string, option: ChatDialogOption, text?: string): ChatAnswer => {
  // eslint-disable-next-line no-control-regex -- These are the characters a field refuses.
  const typed = option.text === "field" ? text?.replace(/[\x00-\x1f\x7f]+/g, " ") : text
  const words = typed?.trim()
  return { type: "choice", dialog, option: option.id, ...(words ? { text: words } : {}) }
}

// A standing yes in two lines, in its own words: what it is, and its scope under it
// ("Yes, and don't ask again" / "for commands that start with `pnpm add`").
export const standingParts = (
  label: string,
): { readonly label: string; readonly effect: string | null } => {
  const match = /^(.*?\bdon't ask again)[,:]?\s+(\S.*)$/i.exec(label.trim())
  return match ? { label: match[1]!, effect: match[2]! } : { label, effect: null }
}

// What a plan's standing yes lets the agent do: only these are said, as their words alone
// don't say what follows.
const planEffect = (label: string): string | null => {
  if (/bypass permissions/i.test(label)) return "It edits and runs commands without asking."
  if (/auto-accept/i.test(label)) return "It edits without asking."
  if (/auto mode/i.test(label)) return "It acts without asking."
  return null
}

// What a permission is for, as a receipt names it: "@crow's command".
const thing = (request: ChatRequest): string => {
  const action = actionOf(request)
  if (action === "plan") return "plan"
  if (action === "run") return "command"
  if (action === "edit") return "edit"
  return request.tool
}

const permissionMenu = (item: InboxRow, request: ChatRequest): Menu => {
  const dialog = request.dialog
  if (dialog?.type !== "choices") return none
  const choices = choicesOf(dialog.options)
  if (!choices) return inTerminal
  const { agent, handle } = item.source
  const who = `@${handle}'s ${thing(request)}`
  const plan = actionOf(request) === "plan"
  const answer = (option: ChatDialogOption, text?: string): InboxAnswer => ({
    kind: "request",
    answer: choiceAnswer(dialog.id, option, text),
  })
  const rows: Row[] = []
  if (choices.allow)
    rows.push({
      type: "answer",
      label: plan ? "Approve" : "Allow",
      effect: null,
      pick: false,
      details: null,
      answer: answer(choices.allow),
      receipt: `${plan ? "Approved" : "Allowed"} ${who}.`,
    })
  for (const option of choices.unsure)
    rows.push({
      type: "answer",
      label: option.label,
      effect: null,
      pick: false,
      details: null,
      answer: answer(option),
      receipt: `Answered ${who}.`,
    })
  for (const option of choices.standing) {
    const parts = standingParts(option.label)
    rows.push({
      type: "answer",
      label: parts.label,
      effect: parts.effect ?? (plan ? planEffect(option.label) : null),
      pick: false,
      details: null,
      answer: answer(option),
      // A plan's standing yes lets the agent act without asking from then on.
      ...(plan && planEffect(option.label) !== null && { hard: true as const }),
      receipt: setsStanding(option)
        ? `${plan ? "Approved" : "Allowed"} ${who}; it won't ask again.`
        : `Answered ${who}.`,
    })
  }
  if (choices.plain)
    rows.push({
      type: "answer",
      label: plan ? "Send it back" : "Deny",
      effect: null,
      pick: false,
      details: null,
      answer: answer(choices.plain),
      receipt: `${plan ? "Sent back" : "Denied"} ${who}.`,
    })
  const note = choices.note
  if (note) {
    // Where the only way back is the person's words (Claude's plan's "Tell Claude what to
    // change"), it needs them; else an empty box is the plain no. It says no in Novadeck's
    // words, as the plain no does, whatever the harness calls it.
    const required = choices.plain === null && needsWords(note)
    const name = agentName(agent)
    rows.push({
      type: "words",
      label: plan ? "Send it back, with your words" : "Deny, with your words",
      placeholder: required ? `Tell ${name} what to change` : `Tell ${name} what to do instead`,
      field: required ? `What ${name} should change` : `What ${name} should do instead`,
      required,
      answer: (text) =>
        answer(text.trim() === "" && choices.plain ? choices.plain : note, text || undefined),
      receipt: (text) =>
        text.trim() === ""
          ? `${plan ? "Sent back" : "Denied"} ${who}.`
          : `${plan ? "Sent back" : "Denied"} ${who}, with your words.`,
      refused: (text) => refusedWords(agent, note, text),
    })
  }
  return { rows, hard: false }
}

// What the person may write in place of an agent's options, or as its answer.
const ownWords = (item: InboxRow, label = "Reply in your own words"): Row => ({
  type: "words",
  label,
  placeholder: `Reply to ${agentName(item.source.agent)}`,
  field: `Reply to ${agentName(item.source.agent)}`,
  required: true,
  answer: (text) => ({ kind: "ask", answer: { type: "reply", option: null, text: text.trim() } }),
  receipt: () => `Reply queued for @${item.source.handle}.`,
  refused: () => null,
})

const askMenu = (item: Extract<InboxRow, { kind: "ask" }>): Menu => {
  const { ask, source } = item
  const { shape } = ask
  const hard = ask.hardToUndo !== null
  if (shape.type === "text") return { rows: [ownWords(item, "Reply")], hard }
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
        ownWords(item),
      ],
      hard,
    }
  return {
    rows: [
      ...shape.options.map((option, index): Row => {
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
      ownWords(item),
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
): Row => ({
  type: "answer",
  label,
  effect,
  pick: false,
  details: null,
  answer: { kind: "trouble", action },
  receipt,
})

const troubleMenu = (item: InboxRow, trouble: Trouble, now: number): Menu => {
  const { handle } = item.source
  switch (trouble.type) {
    case "failed":
      return {
        rows: [
          ...(item.stopped
            ? [
                troubleRow(
                  "Ask it to fix",
                  { type: "nudge", text: fix },
                  `Asked @${handle} to fix it.`,
                  `Sends: “${fix}”`,
                ),
              ]
            : []),
          ...(trouble.stored
            ? [troubleRow("Mark read", { type: "read" }, `Marked @${handle}'s error read.`)]
            : []),
        ],
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
            field: `What ${agentName(item.source.agent)} should try`,
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
      const rows: Row[] = []
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

// The menu of every item but a dialog of questions, at `now`: a limit's reset is read
// against it.
export const menuOf = (item: InboxRow, now: number): Menu => withTerminal(answersOf(item, now))

const answersOf = (item: InboxRow, now: number): Menu => {
  switch (item.kind) {
    case "request": {
      if (item.request.dialog?.type !== "choices") return inTerminal
      return permissionMenu(item, item.request)
    }
    case "held": {
      const { from, to } = item.held
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
      return askMenu(item)
    case "trouble":
      return troubleMenu(item, item.trouble, now)
    case "update":
      return {
        rows: [
          {
            type: "answer",
            label: "Mark read",
            effect: null,
            pick: false,
            details: null,
            answer: { kind: "update", action: "read" },
            receipt: `Marked @${item.source.handle}'s update read.`,
          },
          {
            type: "answer",
            label: `Give @${item.source.handle} a follow-up`,
            effect: "Marks it read and shows its terminal.",
            pick: false,
            details: null,
            answer: { kind: "update", action: "read" },
            receipt: `Marked @${item.source.handle}'s update read.`,
            reveal: true,
          },
        ],
        hard: false,
      }
  }
}

// When a limit resets, said as a sentence: "at 14:00, in 1h 12m", or that it has.
export const resetLabel = (resetsAt: number, now: number): string =>
  resetsAt <= now
    ? `reset at ${clock(resetsAt)}`
    : `resets at ${clock(resetsAt)}, in ${waitLabel(now, resetsAt)}`
