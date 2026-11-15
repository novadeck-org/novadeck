import type { Backend } from "@novadeck/core/port"
import type { PullRequests } from "@novadeck/items/pull-requests"

// What a changes item reads its work's pull request from: the backend's works. Following them
// has the backend read every worktree's git, so an item asks for them only where that finds pull
// requests: while a forge is switched on, from the moment one is until none is. Without works
// there is nothing to read, and the item shows no link.
export const pullRequestsOf = ({
  works,
  forges,
}: Pick<Backend, "works" | "forges">): PullRequests | undefined =>
  works && {
    state: works.state,
    follow: () => {
      if (!forges) return () => {}
      let release: (() => void) | undefined
      const follow = () => {
        const on = forges.state.getSnapshot().some((forge) => forge.enabled)
        if (on && !release) release = works.watch()
        else if (!on && release) {
          release()
          release = undefined
        }
      }
      follow()
      const stop = forges.state.subscribe(follow)
      return () => {
        stop()
        release?.()
        release = undefined
      }
    },
  }
