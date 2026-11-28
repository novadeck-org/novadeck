/**
 * Which UIs and runners work together, as revisions of this contract. A UI and a runner from
 * different releases work together while each is inside the other's window, and are refused
 * at the handshake, with which side to update, once one isn't. Never later, with a call that
 * fails to decode or validate. dev-docs/backend-api.md ("Versions") says how each kind of change
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
  // 14: clients follow each agent's connection, and hear of one lost outside Novadeck
  // (`agents.watch`, an agent's `lost`).
  // 15: pi, an agent the UI may name in an input (a resume, Preferences), marked since 15
  // (`inputEnum`), so a runner at 14 stays in the window and a UI asks for it only of a runner at 15.
  // 16: Novadeck's own pi behind an Experimental switch (settings' `bundledPi`, which a runner
  // before it drops, and `bundledPiFetch`, which says where its download stands); a UI offers the
  // switch only where the runner's settings report `bundledPi`.
  // 17: a work's `title` and `changedAt`.
  // 18: a work's pull request says its target branch, its checks one by one and where its review
  // stands (`base`, `checks`, `review`), the checks' state and the review read tolerantly.
  // 19: the repositories of a project whose origin keeps failing to fetch (`works.origins`).
  // 20: Murmur behind an Experimental switch (settings' `murmur`, which a runner before it drops);
  // a UI hides Murmur's offer and controls only where the runner's settings report it off.
  // 21: the tour runs on Novadeck's own pi (`tour.fetch` downloads it ahead, and settings'
  // `bundledPiFetch` says where that download stands while its switch is off too); a UI offers
  // the tour only to a runner at 21, as one before it runs the tour on opencode.
  // 22: a terminal and a closed terminal say when their agent is Nova, Novadeck's own pi (`nova`),
  // which a UI before it shows as Pi.
  // 23: each git repository in a project says how it stands against origin's main (`projects.sync`,
  // `projects.syncSeen`), and `projects.updateCheckout` takes a repository's `path`.
  // 24: "Keep main current" is a runner setting (settings' `keepMain`, which a runner before it
  // drops); a UI offers the switch only where the runner's settings report it. The runner also
  // moves the local main branch while the checkout is on another branch, so `projects.sync`
  // shows a repository's landing, or its behind with a reason, off main too.
  // 25: `projects.sync` adds what the Files card shows (a repository's `home` and `pullUrl`, a
  // landing's `ref`, a behind's `command` and `local`) and `projects.updateCheckout` says what git
  // printed on a refusal (`git`); all optional, so a UI reads a runner before it without them.
  // 26: Nova and the tour are one Experimental switch: settings' `bundledPi` and `bundledPiFetch`
  // are now `nova` and `novaFetch`, and `tour.fetch` does nothing (kept for UIs before 26), as
  // the tour runs only while Nova is switched on. A UI before it reads neither setting, so offers
  // no Nova switch of a runner at 26; one at 26 offers neither Nova nor the tour to a runner
  // before it.
  revision: 26,
  oldestClient: 11,
  oldestRunner: 12,
}
