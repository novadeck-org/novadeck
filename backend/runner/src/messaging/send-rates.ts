import { allowSend, rates } from "./messages.js"

/** Why a send is over the rates, or the means to spend it once the message is kept. */
export type Verdict =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly spend: () => void }

/**
 * How many messages a minute a terminal that leads `team` terminals may send: an agent's
 * ten, and two more for each terminal it leads, so a lead can direct each of its team.
 */
export const senderRate = (team: number): number => rates.sender + rates.perTeammate * team

const overRate = (limit: number): string =>
  `An agent may send ${limit} messages a minute, ${rates.pair} of them to any one terminal ` +
  "(a send to several terminals you lead counts once); try again shortly."

const overAll =
  "Agents in Novadeck have sent as many messages as they may this minute; try again shortly."

/** The send times that count against the rates: by sender, by sender and recipient, and all. */
export class SendRates {
  private readonly sent = new Map<string, readonly number[]>()
  private readonly pairs = new Map<string, readonly number[]>()
  private all: readonly number[] = []

  /**
   * Whether `sender` may send one more at `now`, within `limit` a minute and the runner's
   * own rate: a send to several terminals is one. A send that is kept calls `spend` to
   * count itself; one refused counts for nothing.
   */
  sender(sender: string, now: number, limit: number = rates.sender): Verdict {
    const bySender = allowSend(this.sent.get(sender) ?? [], now, limit)
    const byAll = allowSend(this.all, now, rates.all)
    if (!bySender) return { ok: false, reason: overRate(limit) }
    if (!byAll) return { ok: false, reason: overAll }
    return {
      ok: true,
      spend: () => {
        this.sent.set(sender, bySender)
        this.all = byAll
      },
    }
  }

  /** Whether `sender` may send `recipient` one more at `now`, as `sender` judges the rest. */
  pair(sender: string, recipient: string, now: number, limit: number = rates.sender): Verdict {
    const pair = `${sender}\0${recipient}`
    const byPair = allowSend(this.pairs.get(pair) ?? [], now, rates.pair)
    if (!byPair) return { ok: false, reason: overRate(limit) }
    return { ok: true, spend: () => this.pairs.set(pair, byPair) }
  }

  /** Whether `sender` may send `recipient` one message at `now`: the pair's rate and its own. */
  check(sender: string, recipient: string, now: number, limit: number = rates.sender): Verdict {
    const pair = this.pair(sender, recipient, now, limit)
    if (!pair.ok) return pair
    const own = this.sender(sender, now, limit)
    if (!own.ok) return own
    return {
      ok: true,
      spend: () => {
        pair.spend()
        own.spend()
      },
    }
  }
}
