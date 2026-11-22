import { inboxType, type InboxEntry, type InboxType } from "@novadeck/core/inbox"

import { tintOf, type Tint } from "./inbox-icons"
import { actionOf, fromNovadeck, labelOf, subjectOf, waitLabel } from "./inbox-text"

// What a toast says of an Inbox entry, in the Inbox's own words: pure, so the toast's
// markup is only a layout of it.
export type ToastText = {
  readonly type: InboxType
  readonly tint: Tint
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

export const toastText = (entry: InboxEntry, now: number): ToastText => {
  const novadeck = fromNovadeck(entry)
  const label = labelOf(entry)
  const command =
    entry.kind === "request" &&
    entry.request.kind !== "question" &&
    actionOf(entry.request) === "run"
      ? entry.request.subject
      : null
  return {
    type: inboxType(entry),
    tint: tintOf(entry),
    handle: novadeck ? undefined : entry.source.handle || undefined,
    novadeck,
    // Novadeck's own lines name it, as its sheets' bylines do ("Novadeck noticed").
    said: novadeck ? label : label.charAt(0).toLowerCase() + label.slice(1),
    command,
    subject: subjectOf(entry).replaceAll("`", ""),
    age: waitLabel(entry.at, now),
    title: entry.source.title,
    project: entry.source.projectName,
  }
}
