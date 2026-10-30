import { allowSend, rates } from "./messages.js"

/** Why a send is over the rates, or the means to spend it once the message is kept. */
type Verdict =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly spend: () => void }

/** The send times that count against the rates: by sender, by sender and recipient, and all. */
export class SendRates {
  private readonly sent = new Map<string, readonly number[]>()
  private readonly pairs = new Map<string, readonly number[]>()
  private all: readonly number[] = []

  /**
   * Whether `sender` may send to `recipient` at `now`. A send that is kept calls `spend`
   * to count itself; one refused counts for nothing.
   */
  check(sender: string, recipient: string, now: number): Verdict {
    const pair = `${sender}\0${recipient}`
    const bySender = allowSend(this.sent.get(sender) ?? [], now, rates.sender)
    const byPair = allowSend(this.pairs.get(pair) ?? [], now, rates.pair)
    const byAll = allowSend(this.all, now, rates.all)
    if (!bySender || !byPair)
      return {
        ok: false,
        reason:
          `An agent may send ${rates.sender} messages a minute, ${rates.pair} of them to any ` +
          "one terminal; try again shortly.",
      }
    if (!byAll)
      return {
        ok: false,
        reason:
          "Agents in Novadeck have sent as many messages as they may this minute; try again shortly.",
      }
    return {
      ok: true,
      spend: () => {
        this.sent.set(sender, bySender)
        this.pairs.set(pair, byPair)
        this.all = byAll
      },
    }
  }
}
