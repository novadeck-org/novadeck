import { requestTicket, serviceEndpoint, type Ticket } from "@novadeck/harness-nova/ticket"

import { TourError } from "./errors.js"

export type { Ticket }

/** Where the tour's model service is: Nova's (`serviceEndpoint`). */
export const tourEndpoint = serviceEndpoint

const unreachable =
  "Novadeck couldn't reach the tour's service just now, so the tour can't start. Check your connection and try again."

/**
 * A ticket for one run of the tour, from `<endpoint>/tickets` (Nova's `requestTicket`): the tour's
 * agents are paid for by Novadeck, through its website, which hands out a few tickets a day to
 * each person and counts the model calls of each. The ticket is the API key the agents' provider
 * is given. The service's own sentence for a refusal is the `TourError`'s, and so what the
 * consent shows; anything else it answers, or no answer, is a sentence of ours.
 */
export const fetchTicket = async (
  endpoint: string,
  request: typeof fetch = fetch,
): Promise<Ticket> => {
  const answer = await requestTicket(endpoint, request)
  if (answer.ok) return answer.ticket
  throw new TourError(answer.said ?? unreachable)
}
