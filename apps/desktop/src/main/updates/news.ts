// What is new: in the version the person now runs, shown once after an update, and in the
// version a portable copy is offered. The rules live in ./whats-new.ts; this hands them the
// app's state and network.
import { app, net } from "electron"

import { isNewerVersion } from "../releases/versions.js"
import { releaseRepository } from "../resources.js"
import type { keepUpdateState } from "./state.js"
import { keepUpdateNews, keepWhatsNew, whatsNewAtLaunch } from "./whats-new.js"

/** What the news is handed of the running app. */
export type NewsHost = {
  readonly state: ReturnType<typeof keepUpdateState>
  /**
   * Whether the app ran in this data folder before this launch, as the runner's database
   * shows; read before the runner starts, so this launch's own database doesn't count.
   */
  readonly ranBefore: boolean
  /** The version the app's last update offer named as available, if it did. */
  readonly offeredVersion: () => string | undefined
  readonly warn: (message: string, error: unknown) => void
}

/** What is new after an update and in an offered one; see ./whats-new.ts. */
export const updateNewsOf = ({ state, ranBefore, offeredVersion, warn }: NewsHost) => {
  // The launch is settled first, once, and the page's request waits for it.
  let launch: Promise<void> | undefined
  const settleLaunch = (): Promise<void> =>
    (launch ??= (async () => {
      const repository = await releaseRepository()
      const kept = state.read()
      const settled = whatsNewAtLaunch(
        {
          previous: kept.lastRunVersion,
          current: app.getVersion(),
          pending: kept.whatsNewPending,
          from: kept.whatsNewFrom,
          settled: kept.whatsNewSettled,
          ranBefore,
          offerable: repository !== undefined,
        },
        isNewerVersion,
      )
      if (settled) state.recordLaunch(settled.lastRunVersion, settled.pending, settled.from)
    })().catch((error: unknown) => warn("The launch was not recorded.", error)))

  return {
    /**
     * Settles what this launch shows once after an update. Before the runner makes its
     * database, which marks a data folder as used: a launch that dies in between must not
     * make the next one look like an update.
     */
    settleLaunch,

    /** What the person is shown once after an update. */
    whatsNew: keepWhatsNew({
      version: app.getVersion(),
      launched: settleLaunch,
      pending: () => state.read().whatsNewPending,
      from: () => state.read().whatsNewFrom,
      clear: () => state.settleWhatsNew(app.getVersion(), isNewerVersion),
      checkedAt: () => state.read().whatsNewCheckedAt,
      recordCheck: (time) => state.recordWhatsNewCheck(time),
      now: Date.now,
      repository: releaseRepository,
      fetch: (url, init) => net.fetch(url, init),
      newer: isNewerVersion,
      log: warn,
    }),

    /** What is new in the version a portable copy is offered, which it cannot install itself. */
    offeredNews: keepUpdateNews({
      version: app.getVersion(),
      offered: offeredVersion,
      repository: releaseRepository,
      fetch: (url, init) => net.fetch(url, init),
      newer: isNewerVersion,
      log: warn,
    }),
  }
}
