import { inboxType, type InboxEntry, type InboxType, type SettledHow } from "@novadeck/core/inbox"

import { tintOf, type Tint } from "./inbox-icons"
import { actionOf } from "./inbox-text"

// The word that leads a sheet's head, so what kind of message it is reads before any of it:
// with the entry's own icon and tint. Pure, so the words read apart from the markup.

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
  away: "Ended",
} as const satisfies Record<SettledHow, TagWord>

const wordOf = (entry: InboxEntry): TagWord => {
  switch (entry.kind) {
    case "request": {
      if (entry.request.kind === "question") return "Question"
      const action = actionOf(entry.request)
      if (action === "plan") return "Plan"
      if (action === "run") return "Command"
      if (action === "edit") return "Edit"
      return "Tool"
    }
    case "held":
      return "Held"
    case "ask":
      return entry.ask.shape.type === "action" ? "Your move" : "Question"
    case "trouble":
      if (entry.trouble.type === "failed") return "Error"
      if (entry.trouble.type === "limit") return "Limit"
      if (entry.trouble.type === "stuck") return "Stuck"
      return "Undelivered"
    case "update":
      return "Update"
  }
}

// A resolved entry asks nothing, and says how it ended, in gray.
export const tagOf = (entry: InboxEntry): Tag => {
  const type = inboxType(entry)
  if (entry.settled) return { word: settledWords[entry.settled.how], type, tint: tintOf(entry) }
  return { word: wordOf(entry), type, tint: tintOf(entry) }
}
