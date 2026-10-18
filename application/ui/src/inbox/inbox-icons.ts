import {
  Info,
  MessageCircleQuestionMark,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"

import type { InboxType } from "#core/inbox"

// The icon says the type; its tint (inbox.css) says whether it needs the person.
export const icons: Readonly<Record<InboxType, LucideIcon>> = {
  trouble: TriangleAlert,
  approve: ShieldCheck,
  ask: MessageCircleQuestionMark,
  update: Info,
}

// What each type is called, for a screen reader.
export const typeWords: Readonly<Record<InboxType, string>> = {
  trouble: "Trouble",
  approve: "Approve",
  ask: "Ask",
  update: "Update",
}
