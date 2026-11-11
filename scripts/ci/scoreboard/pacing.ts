// How the scoreboard spends the token's hourly request budget, which every other workflow of
// the repository (Nightly Report, Known Flakes, the plans) draws on too.

/** Requests left for the others: the scoreboard never takes the budget below this. */
export const headroom = 200

export type Pace =
  | { kind: "fetch"; count: number }
  /** Wait until this time, in seconds since the epoch, when the budget is renewed. */
  | { kind: "wait"; until: number }

/** How many of `needed` requests to make now, given `remaining` in the budget, or when to wait for `reset`. */
export const pace = (remaining: number, reset: number, needed: number): Pace => {
  const spare = remaining - headroom
  return spare > 0
    ? { kind: "fetch", count: Math.min(needed, spare) }
    : { kind: "wait", until: reset }
}
