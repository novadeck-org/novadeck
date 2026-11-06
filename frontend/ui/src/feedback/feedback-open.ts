import type { FeedbackKind } from "@novadeck/core/feedback"
import { createStore } from "@novadeck/core/store"

// A request from elsewhere in the footer to open the feedback card, as the heads-up card's
// "Bad call? Tell us" does. The button (`FeedbackButton`) answers it: the card opens with
// the kind picked and `about` as a line saying what the note is on, unless the person has a
// note or an agent's draft in it already, which it leaves as it is. The line is for the person:
// it is not part of the note. Each request has its own id, so asking twice opens it twice, and a request
// made before the button was mounted is not answered by it.
export type FeedbackRequest = {
  readonly id: number
  readonly kind: FeedbackKind
  readonly about: string
}

export const feedbackRequests = createStore<FeedbackRequest | null>(null)

let made = 0

export const requestFeedback = (kind: FeedbackKind, about: string): void => {
  made += 1
  const request = { id: made, kind, about }
  feedbackRequests.update(() => request)
}
