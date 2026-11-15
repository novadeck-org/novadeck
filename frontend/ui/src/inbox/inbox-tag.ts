import { inboxType, type InboxRow, type InboxType, type SettledHow } from "@novadeck/core/inbox"

import { tintOf, type Tint } from "./inbox-icons"
import { actionOf } from "./inbox-text"

// The word that leads a sheet's head, so what kind of message it is reads before any of it:
// with the row's own icon and tint. Pure, so the words read apart from the markup.

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
  | "Answered"
  | "Dismissed"
  | "Replied"
  | "Released"
  | "Stopped"
  | "Resolved"
  | "Delivered"
  | "Read"
  | "Ended"

export type Tag = { readonly word: TagWord; readonly type: InboxType; readonly tint: Tint }

const settledWords = {
  answered: "Answered",
  terminal: "Answered",
  dismissed: "Dismissed",
  replied: "Replied",
  released: "Released",
  stopped: "Stopped",
  worked: "Resolved",
  delivered: "Delivered",
  read: "Read",
  gone: "Ended",
  ended: "Ended",
} as const satisfies Record<SettledHow, TagWord>

const wordOf = (row: InboxRow): TagWord => {
  switch (row.kind) {
    case "request": {
      if (row.request.kind === "question") return "Question"
      const action = actionOf(row.request)
      if (action === "plan") return "Plan"
      if (action === "run") return "Command"
      if (action === "edit") return "Edit"
      return "Tool"
    }
    case "held":
      return "Held"
    case "ask":
      return row.ask.shape.type === "action" ? "Your move" : "Question"
    case "trouble":
      if (row.trouble.type === "failed") return "Error"
      if (row.trouble.type === "limit") return "Limit"
      if (row.trouble.type === "stuck") return "Stuck"
      return "Undelivered"
    case "update":
      return "Update"
  }
}

// A resolved row asks nothing, and says how it ended, in gray.
export const tagOf = (row: InboxRow): Tag => {
  const type = inboxType(row)
  if (row.settled) return { word: settledWords[row.settled.how], type, tint: tintOf(row) }
  return { word: wordOf(row), type, tint: tintOf(row) }
}
