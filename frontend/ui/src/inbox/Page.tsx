import type { InboxAnswer, InboxRow } from "@novadeck/core/inbox"
import type { ReactNode } from "react"

import { labelOf, fromNovadeck, subjectOf, type Standing } from "./inbox-text"
import type { Sent as SentAnswer } from "./InboxProvider"
import { Byline, Text } from "./sheet-parts"

// What each kind of sheet gets: its item, and what the sheet knows around it.
export type SheetContentProps = {
  readonly item: InboxRow
  readonly standing: Standing
  // The answer the person gave, once they have.
  readonly sent: SentAnswer | undefined
  // Whether an answer is on its way, and why the last one didn't take.
  readonly answering: boolean
  readonly failed: string | undefined
  // Goes on to what asks next, where something does.
  readonly onNext: (() => void) | undefined
  // Answers the item, with what to tell the person it did.
  readonly submit: (answer: InboxAnswer, note: string) => void
  // Changes how the item is handled, without answering it: it stays.
  readonly change: (answer: InboxAnswer) => void
  // Shows the item's terminal.
  readonly reveal: () => void
}

// A sheet's page: what it says, scrolling, and over it, fixed, the box its reply goes in.
export const Page = ({
  footer,
  children,
}: {
  readonly footer?: ReactNode
  readonly children: ReactNode
}): React.JSX.Element => (
  <>
    <div className="inbox-sheet-scroll">
      <div className="inbox-sheet-page">{children}</div>
    </div>
    {footer && <div className="inbox-sheet-footer">{footer}</div>}
  </>
)

// The byline and the subject, which open every sheet. A permission leaves the subject out:
// its command, shown large below, says it already.
export const Lead = ({
  item,
  standing,
  subject = true,
}: SheetContentProps & { readonly subject?: boolean }): React.JSX.Element => (
  <>
    <Byline
      label={labelOf(item)}
      novadeck={fromNovadeck(item)}
      status={standing.status}
      statusTone={standing.tone}
    />
    {subject && (
      <h3 className="inbox-title">
        <Text text={subjectOf(item)} />
      </h3>
    )}
  </>
)
