import { describe, expect, it } from "vitest"

import { heldOptions, heldRef } from "../harnesses/detail.js"
import { answeredCard } from "./held.js"
import { Shipping } from "./service.js"

const binding = { agent: "claude", sessionId: "s1" } as never
const record = { summary: { id: "t" }, bound: { binding } } as never

const setup = () => {
  const told: string[] = []
  const shipping = new Shipping({
    enabled: () => true,
    owned: { ofTerminal: () => [], all: () => [] },
    notify: (_id, text) => (told.push(text), true),
  })
  const card = shipping.cards.ask("t", ["land:r/app:main"], false, "Land work on main?", "").card
  return { shipping, card, told, request: heldRef(binding, card) }
}
const choice = (card: { id: string }, option: string) =>
  ({ type: "choice", dialog: `permit-${card.id}`, option }) as const

describe("an answer to a request, as the shipping gate's cards take it", () => {
  it("is left to the harness's own dialogs where no card is named, or nothing is held", () => {
    const { shipping, card } = setup()
    expect(answeredCard(shipping, record, "some-other-request", choice(card, "x"))).toBeUndefined()
    expect(answeredCard(undefined, record, "r", choice(card, "x"))).toBeUndefined()
    expect(answeredCard(shipping, undefined, "r", choice(card, "x"))).toBeUndefined()
    expect(
      answeredCard(
        shipping,
        { summary: { id: "t" }, bound: null } as never,
        "r",
        choice(card, "x"),
      ),
    ).toBeUndefined()
    // Another terminal's request is none of this one's.
    expect(
      answeredCard(
        shipping,
        { summary: { id: "u" }, bound: { binding } } as never,
        heldRef(binding, card),
        choice(card, heldOptions.allow),
      ),
    ).toBeUndefined()
  })

  it("refuses an answer that isn't to the card's own dialog, or isn't Allow or Deny", () => {
    const { shipping, card, request } = setup()
    expect(() =>
      answeredCard(shipping, record, request, {
        type: "choice",
        dialog: "permit-other",
        option: heldOptions.allow,
      }),
    ).toThrow(/not the card's own dialog/)
    expect(() =>
      answeredCard(shipping, record, request, { type: "text", text: "yes" } as never),
    ).toThrow(/not the card's own dialog/)
    expect(() => answeredCard(shipping, record, request, choice(card, "Maybe"))).toThrow(
      /Allow or Deny/,
    )
    // Nothing was decided: the card is still open and nothing is permitted.
    expect(shipping.cards.of("t")).toHaveLength(1)
    expect(shipping.permits.covering("t", "land:r/app:main")).toBeUndefined()
  })

  it("gives the permit on Allow, naming the client that answered, and the first answer wins", async () => {
    const { shipping, card, request, told } = setup()
    await answeredCard(shipping, record, request, choice(card, heldOptions.allow), "window-2")
    expect(shipping.permits.covering("t", "land:r/app:main")?.source).toEqual({
      type: "answer",
      card: card.id,
      client: "window-2",
    })
    expect(told).toHaveLength(1)
    expect(answeredCard(shipping, record, request, choice(card, heldOptions.deny))).toBeUndefined()
  })

  it("gives nothing on Deny, and says so", async () => {
    const { shipping, card, request, told } = setup()
    await answeredCard(shipping, record, request, choice(card, heldOptions.deny), "window-2")
    expect(shipping.permits.covering("t", "land:r/app:main")).toBeUndefined()
    expect(shipping.cards.of("t")).toHaveLength(0)
    expect(told[0]).toContain("declined")
  })
})
