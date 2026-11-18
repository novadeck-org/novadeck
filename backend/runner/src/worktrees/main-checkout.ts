import type { CheckoutState, CheckoutUpdate } from "@novadeck/protocol"

import { behindMain } from "../checkouts/repository.js"
import { operationIn, trackedChanges, type Forwarded } from "./fast-forward.js"
import { repositoryAt } from "./repo.js"

/** What the checkout service asks of the worktrees service. */
export type MainCheckoutHost = {
  readonly moved: (commonDir: string) => number
  readonly update: (commonDir: string) => Promise<Forwarded>
}

/**
 * A project's own checkout against its remote's main, for the Files panel: how far behind it is
 * where the runner left it alone, and a move to main on the person's say.
 */
export class MainCheckouts {
  constructor(private readonly host: MainCheckoutHost) {}

  /**
   * `behind` only where the runner would not have moved the checkout by itself: it has tracked
   * changes or an operation half done. Otherwise the next fetch moves it, and nothing is said.
   */
  async read(cwd: string): Promise<CheckoutState> {
    const found = await repositoryAt(cwd)
    if (!found.ok) return { behind: null, moved: 0 }
    const { home, commonDir } = found.repository
    const moved = this.host.moved(commonDir)
    const behind = await behindMain(home)
    if (behind === undefined) return { behind: null, moved }
    const held = (await operationIn(home)) !== undefined || (await trackedChanges(home)) !== false
    return {
      behind: held ? { branch: behind.branch, remote: behind.remote, count: behind.behind } : null,
      moved,
    }
  }

  async update(cwd: string): Promise<CheckoutUpdate> {
    const found = await repositoryAt(cwd)
    if (!found.ok) return { ok: false, said: "It isn't in a git repository." }
    const done = await this.host.update(found.repository.commonDir)
    return done.ok ? { ok: true } : done
  }
}
