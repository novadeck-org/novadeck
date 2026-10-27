import { inboxType, type InboxRow, type InboxType } from "@novadeck/core/inbox"

import { actionOf, toneOf, type Tone } from "./inbox-text"

// The word that leads a sheet's head, so what kind of message it is reads before any of it:
// with the row's own icon (by `type`) and tone. Pure, so the words read apart from the markup.

export type TagWord =
  | "Command"
  | "Edit"
  | "Tool"
  | "Plan"
  | "Your move"
  | "Question"
  | "Held"
  | "Error"
  | "Limit"
  | "Stuck"
  | "Undelivered"
  | "Update"
  | "Feedback"
  | "Withdrawn"
  | "Dismissed"
  | "Replied"

export type Tag = { readonly word: TagWord; readonly type: InboxType; readonly tone: Tone }

const settledWords = {
  withdrawn: "Withdrawn",
  dismissed: "Dismissed",
  replied: "Replied",
} as const satisfies Record<NonNullable<InboxRow["settled"]>["how"], TagWord>

const wordOf = (item: InboxRow): TagWord => {
  switch (item.kind) {
    case "request": {
      if (item.request.kind === "question") return "Question"
      const action = actionOf(item.request)
      if (action === "plan") return "Plan"
      if (action === "run") return "Command"
      if (action === "edit") return "Edit"
      return "Tool"
    }
    case "held":
      return "Held"
    case "ask":
      return item.ask.shape.type === "action" ? "Your move" : "Question"
    case "trouble":
      if (item.trouble.type === "failed") return "Error"
      if (item.trouble.type === "limit") return "Limit"
      if (item.trouble.type === "stuck") return "Stuck"
      return "Undelivered"
    case "update":
      return "Update"
    case "feedback":
      return "Feedback"
  }
}

// A settled ask asks nothing, and says how it settled: its agent withdrew it, the person
// dismissed it, or wrote to its agent in the terminal. An agent's ask whose
// answer it says is hard to take back is red; a permission carries no such flag, so none is
// guessed at.
export const tagOf = (item: InboxRow): Tag => {
  const type = inboxType(item)
  if (item.settled) return { word: settledWords[item.settled.how], type, tone: "quiet" }
  const hard = item.kind === "ask" && item.ask.hardToUndo !== null
  return { word: wordOf(item), type, tone: hard ? "urgent" : toneOf(item) }
}
