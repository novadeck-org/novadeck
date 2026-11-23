import type { ChatPermit } from "@novadeck/core/conversation"
import { permitBasis, permitStands } from "@novadeck/core/permits"

// What a permit of the shipping gate that stands says, in facts: what it covers, on which words
// it was given, and until when. The chat's card and the Inbox's sheet draw it alike.
export const PermitFacts = ({
  permit,
  now,
}: {
  readonly permit: ChatPermit
  // The person's clock, for the day a time is said on.
  readonly now: number
}): React.JSX.Element => (
  <>
    <p className="request-subject">{permit.title}</p>
    <p className="request-note">{permitBasis(permit)}</p>
    <p className="request-note">{permitStands(permit, now)}</p>
  </>
)
