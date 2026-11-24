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
  // 5: clients follow the projects and sessions others make, arrange and remove
  //    (`projects.watch`, and `sessions.watch`'s `arranged`).
  // 6: each device has its own credential, revoked on its own (`devices.*`).
  // 7: the person's settings follow them from device to device, live (`settings.watch`,
  //    `preferences.*`).
  // 8: a terminal's control moves between clients (`terminals.take`, `terminals.controls`).
  // 9: an agent asks several questions at once (an ask's `questions` shape, `inbox.answerQuestions`).
  // 10: the shipping gate's standing permits (`agents.detail` `permits`, a terminal's `permits`,
  //     `agents.takeBack`).
  // 11: opencode, an agent the UI may name in an input (a resume, Preferences, the tour), which
  // runners before it refuse; and an agent's `limited` gains reasons (outdated, unsupported),
  // read tolerantly from here, which UIs before it don't.
  // 12: the tour runs on opencode alone, on a model of Novadeck's (`tour.prepare` takes no
  // agent, which a runner before it requires).
  // 13: a terminal says which agent it is starting (a terminal's `expecting`), so a client
  // shows its chat from the start.
  // 14: pi, an agent the UI may name in an input (a resume, Preferences), marked since 14
  // (`inputEnum`), so a runner at 13 stays in the window and a UI asks for it only of a runner at 14.
  revision: 14,
  oldestClient: 11,
  oldestRunner: 12,
}
