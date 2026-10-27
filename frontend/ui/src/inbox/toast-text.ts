import { inboxType, type InboxRow, type InboxType } from "@novadeck/core/inbox"

import {
  actionOf,
  fromNovadeck,
  labelOf,
  subjectOf,
  toneOf,
  waitLabel,
  type Tone,
} from "./inbox-text"

// What a toast says of an Inbox item, in the Inbox's own words: pure, so the toast's
// markup is only a layout of it.
export type ToastText = {
  readonly type: InboxType
  readonly tone: Tone
  // The agent's handle, bare; none for what Novadeck itself says.
  readonly handle: string | undefined
  readonly novadeck: boolean
  // Who wants what, as the OS ping words it after the handle: "asks you".
  readonly said: string
  // A command the agent wants to run, shown as one; else the subject is the text.
  readonly command: string | null
  readonly subject: string
  readonly age: string
  readonly title: string
  readonly project: string
}

export const toastText = (item: InboxRow, now: number): ToastText => {
  const novadeck = fromNovadeck(item)
  const label = labelOf(item)
  const command =
    item.kind === "request" && item.request.kind !== "question" && actionOf(item.request) === "run"
      ? item.request.subject
      : null
  return {
    type: inboxType(item),
    tone: toneOf(item),
    handle: novadeck ? undefined : item.source.handle || undefined,
    novadeck,
    // Novadeck's own lines name it, as its sheets' bylines do ("Novadeck noticed").
    said: novadeck ? label : label.charAt(0).toLowerCase() + label.slice(1),
    command,
    subject: subjectOf(item).replaceAll("`", ""),
    age: waitLabel(item.at, now),
    title: item.source.title,
    project: item.source.projectName,
  }
}
