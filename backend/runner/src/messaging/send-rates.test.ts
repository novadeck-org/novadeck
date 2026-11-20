import { describe, expect, it } from "../test.js"
import { rates } from "./messages.js"
import { SendRates } from "./send-rates.js"

// One send from `sender` to `recipient` at `now`, counted when the rates let it go.
const send = (sendRates: SendRates, sender: string, recipient: string, now: number) => {
  const verdict = sendRates.check(sender, recipient, now)
  if (verdict.ok) verdict.spend()
  return verdict.ok
}

describe("send rates", () => {
  it("refuse a sender's eleventh message in a minute, and its fourth to one terminal", () => {
    const sendRates = new SendRates()
    const now = 1_000_000
    expect([1, 2, 3, 4].map((at) => send(sendRates, "A", "B", now + at))).toEqual([
      true,
      true,
      true,
      false,
    ])
    const others = Array.from({ length: 8 }, (_, at) =>
      send(sendRates, "A", `T${at}`, now + 10 + at),
    )
    expect(others).toEqual([true, true, true, true, true, true, true, false])
    // A minute after the first, they count no more.
    expect(send(sendRates, "A", "B", now + rates.windowMs + 1)).toBe(true)
  })

  it("let go of senders and pairs whose sends have all passed out of the window", () => {
    const sendRates = new SendRates()
    // A long day: 200 terminals each send once to 5 others, within the runner's own rate.
    let now = 1_000_000
    for (let sender = 0; sender < 200; sender++)
      for (let to = 1; to <= 5; to++) {
        expect(send(sendRates, `T${sender}`, `T${(sender + to) % 200}`, now)).toBe(true)
        now += 2_000
      }
    // Only the last minute's sends still count: one every 2 s, five from each sender.
    expect(sendRates.kept).toEqual({ senders: 6, pairs: 30 })
    // An hour later, only the one send that still counts is kept.
    now += 60 * rates.windowMs
    expect(send(sendRates, "T0", "T1", now)).toBe(true)
    expect(sendRates.kept).toEqual({ senders: 1, pairs: 1 })
  })
})
