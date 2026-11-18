import type { CheckoutState, CheckoutUpdate } from "@novadeck/protocol"

import { behindMain } from "../checkouts/repository.js"
import type { Forwarded } from "./fast-forward.js"
import { commitAt, repositoryAt } from "./repo.js"

/** What the checkout service asks of the worktrees service. */
export type MainCheckoutHost = {
  readonly moved: (commonDir: string) => number
  readonly update: (commonDir: string) => Promise<Forwarded>
}

/**
 * A project's own checkout against its remote's main, for the Files panel: how far behind it is
 * where the runner left it, and a move to main on the person's say.
 */
export class MainCheckouts {
  constructor(private readonly host: MainCheckoutHost) {}

  /**
   * `behind` wherever the checkout is on main with main ahead of it: the runner moves one that
   * nothing holds back on the next fetch, so this is what it left, for whatever reason (changes
   * of its own, an operation half done, a file in the way); a clean one that has yet to be
   * fetched shows too, which the person's Update moves. `head` is the commit HEAD is at.
   */
  async read(cwd: string): Promise<CheckoutState> {
    const found = await repositoryAt(cwd)
    if (!found.ok) return { behind: null, moved: 0, head: null }
    const { home, commonDir } = found.repository
    const moved = this.host.moved(commonDir)
    const head = (await commitAt(home, "HEAD")) ?? null
    const behind = await behindMain(home)
    return {
      behind: behind
        ? { branch: behind.branch, remote: behind.remote, count: behind.behind }
        : null,
      moved,
      head,
    }
  }

  async update(cwd: string): Promise<CheckoutUpdate> {
    const found = await repositoryAt(cwd)
    if (!found.ok) return { ok: false, said: "It isn't in a git repository." }
    const done = await this.host.update(found.repository.commonDir)
    return done.ok ? { ok: true } : done
  }
}
