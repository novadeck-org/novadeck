import type { InboxRow, InboxType } from "@novadeck/core/inbox"
import {
  ClipboardList,
  Flag,
  Gauge,
  ListChecks,
  MailWarning,
  MessageCircleQuestionMark,
  MessageSquareLock,
  MessageSquareText,
  OctagonX,
  Repeat2,
  ShieldQuestionMark,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react"

import { actionOf } from "./inbox-text"

// One icon per kind of row, tinted by what the row wants of the person (inbox.css); a row that
// is resolved keeps its icon, in gray.

// The kinds of row that have an icon of their own.
export type IconKey =
  | "permission"
  | "plan"
  | "question"
  | "options"
  | "action"
  | "held"
  | "limit"
  | "waits"
  | "failed"
  | "stuck"
  | "done"
  | "told"

export const icons: Readonly<Record<IconKey, LucideIcon>> = {
  permission: ShieldQuestionMark,
  plan: ClipboardList,
  question: MessageCircleQuestionMark,
  options: ListChecks,
  action: SquareTerminal,
  held: MessageSquareLock,
  limit: Gauge,
  waits: MailWarning,
  failed: OctagonX,
  stuck: Repeat2,
  done: Flag,
  told: MessageSquareText,
}

// The kind of a row, for its icon: a harness's dialog by what it asks (a permission, a plan, a
// question), an agent's ask by its shape (options, an action to do, words), what Novadeck holds
// or noticed, and what an agent reported.
export const iconKey = (row: InboxRow): IconKey => {
  switch (row.kind) {
    case "request":
      if (row.request.kind === "question") return "question"
      return actionOf(row.request) === "plan" ? "plan" : "permission"
    case "held":
      return "held"
    case "ask":
      if (row.ask.shape.type === "options") return "options"
      return row.ask.shape.type === "action" ? "action" : "question"
    case "trouble":
      return row.trouble.type
    case "update":
      return row.update.type
  }
}

// The icon of a row, which it keeps once it is resolved, in gray.
export const iconOf = (row: InboxRow): LucideIcon => icons[iconKey(row)]

// What a row's colour says of it: it waits on the person (`attention`), it is a note of
// Novadeck's about messages or a limit, it failed (`danger`), an agent finished (`success`), an
// agent told them something (`ink`), or it is resolved (`muted`).
export type Tint = "attention" | "note" | "danger" | "success" | "ink" | "muted"

export const tintOf = (row: InboxRow): Tint => {
  if (row.settled) return "muted"
  switch (row.kind) {
    case "request":
    case "held":
    case "ask":
      return "attention"
    case "trouble":
      return row.trouble.type === "limit" || row.trouble.type === "waits" ? "note" : "danger"
    case "update":
      return row.update.type === "done" ? "success" : "ink"
  }
}

// What each type is called, for a screen reader.
export const typeWords: Readonly<Record<InboxType, string>> = {
  trouble: "Trouble",
  unblock: "Unblock",
  ask: "Ask",
  update: "Update",
}
