/**
 * Which UIs and runners work together, as revisions of this contract. A UI and a runner from
 * different releases work together while each is inside the other's window, and are refused
 * at the handshake, with which side to update, once one isn't. Never later, with a call that
 * fails to decode or validate. docs/backend-api.md ("Versions") says how each kind of change
 * ships; `contract.json` beside this package is the contract as each release had it, which
 * `scripts/compatibility` compares the next one with.
 */
export type Compatibility = {
  /** The contract this build speaks, raised once in each release whose contract changed. */
  readonly revision: number
  /** The oldest UI a runner of this build serves: one below it is refused. */
  readonly oldestClient: number
  /** The oldest runner a UI of this build works with: one below it is refused. */
  readonly oldestRunner: number
}

/**
 * Revision 1 was every build before the window, which compared versions exactly: none of them
 * is inside it, as a UI and its runner always shipped together until then.
 */
export const compatibility: Compatibility = {
  // 3: UIs read open schemas tolerantly (open.ts), which UIs at 2 don't.
  // 4: sessions keep a revision, and clients share them (`sessions.change`, `sessions.watch`).
  revision: 4,
  oldestClient: 3,
  oldestRunner: 2,
}
