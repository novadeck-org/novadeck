import type { RequestAnswer } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { heldOptions, heldRef } from "../harnesses/detail.js"
import type { Record } from "../terminals/record.js"
import type { Shipping } from "./service.js"

/**
 * The person's answer to a request, when it is to one of the shipping gate's action cards: it
 * resolves in the runner, with no key pressed, and the first answer wins. Undefined where
 * `request` names no open card, for the harness's own dialogs to take.
 */
export const answeredCard = (
  shipping: Shipping | undefined,
  record: Pick<Record, "bound" | "summary"> | undefined,
  request: string,
  answer: RequestAnswer,
  /** The client session that answered, which the permit's record names. */
  client?: string,
): Promise<void> | undefined => {
  const binding = record?.bound?.binding
  if (!shipping || !record || !binding) return undefined
  const terminalId = record.summary.id
  const card = shipping.cards.of(terminalId).find((each) => heldRef(binding, each) === request)
  if (!card) return undefined
  if (answer.type !== "choice" || answer.dialog !== `permit-${card.id}`)
    throw new DomainError("DIALOG_CHANGED", "That is not the card's own dialog.")
  if (answer.option !== heldOptions.allow && answer.option !== heldOptions.deny)
    throw new DomainError("ANSWER_FAILED", "Choose Allow or Deny.")
  shipping.answered(card, answer.option === heldOptions.allow, client)
  return Promise.resolve()
}
