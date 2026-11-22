import type { InboxEntry, InboxType } from "@novadeck/core/inbox"
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

// One icon per kind of entry, tinted by what the entry wants of the person (inbox.css); an entry that
// is resolved keeps its icon, in gray.

// The kinds of entry that have an icon of their own.
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

// The kind of an entry, for its icon: a harness's dialog by what it asks (a permission, a plan, a
// question), an agent's ask by its shape (options, an action to do, words), what Novadeck holds
// or noticed, and what an agent reported.
export const iconKey = (entry: InboxEntry): IconKey => {
  switch (entry.kind) {
    case "request":
      if (entry.request.kind === "question") return "question"
      return actionOf(entry.request) === "plan" ? "plan" : "permission"
    case "held":
      return "held"
    case "ask":
      if (entry.ask.shape.type === "options") return "options"
      return entry.ask.shape.type === "action" ? "action" : "question"
    case "trouble":
      return entry.trouble.type
    case "update":
      return entry.update.type
  }
}

// The icon of an entry, which it keeps once it is resolved, in gray.
export const iconOf = (entry: InboxEntry): LucideIcon => icons[iconKey(entry)]

// What an entry's colour says of it: it waits on the person (`attention`), it is a note of
// Novadeck's about messages or a limit, it failed (`danger`), an agent finished (`success`), an
// agent told them something (`ink`), or it is resolved (`muted`).
export type Tint = "attention" | "note" | "danger" | "success" | "ink" | "muted"

export const tintOf = (entry: InboxEntry): Tint => {
  if (entry.settled) return "muted"
  switch (entry.kind) {
    case "request":
    case "held":
    case "ask":
      return "attention"
    case "trouble":
      return entry.trouble.type === "limit" || entry.trouble.type === "waits" ? "note" : "danger"
    case "update":
      return entry.update.type === "done" ? "success" : "ink"
  }
}

// What each type is called, for a screen reader.
export const typeWords: Readonly<Record<InboxType, string>> = {
  trouble: "Trouble",
  unblock: "Unblock",
  ask: "Ask",
  update: "Update",
}
