import type { InboxAnswer, InboxRow } from "@novadeck/core/inbox"

import type { Sent as SentAnswer } from "./InboxProvider"

// What each kind of sheet gets: its item, and what the sheet knows around it.
export type SheetContentProps = {
  readonly item: InboxRow
  // The answer the person gave, once they have.
  readonly sent: SentAnswer | undefined
  // Whether an answer is on its way, and why the last one didn't take.
  readonly answering: boolean
  readonly failed: string | undefined
  // Answers the item, with the receipt that tells the person what it did.
  readonly submit: (answer: InboxAnswer, note: string) => void
  // Changes how the item is handled, without answering it: it stays.
  readonly change: (answer: InboxAnswer) => void
  // Shows the item's terminal.
  readonly reveal: () => void
}
