import type { PullRequest } from "@novadeck/core/forges"
import type { Store } from "@novadeck/core/store"
import type { Work, WorksState } from "@novadeck/core/works"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react"

// The pull request of the work a changes item shows, as the forges the person switched on found
// it: the app's works, which carry each one's (see core's `works`). Outside the workspace, or
// where the backend has no works, there is none and the item shows no link.

export type PullRequests = {
  readonly state: Store<WorksState>
  // Has the backend follow the works while an item asks, where that finds pull requests (a forge
  // is on); returns the release.
  readonly follow: () => () => void
}

export const PullRequestsContext = createContext<PullRequests | undefined>(undefined)

/** The pull request of the work at `root`, where it has one. */
export const pullRequestAt = (works: readonly Work[], root: string): PullRequest | undefined =>
  works.find((work) => work.root === root)?.pullRequest

/** Whether two answers show the same: works come again whole, with new objects. */
export const samePullRequest = (a: PullRequest | undefined, b: PullRequest | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.number === b.number &&
    a.url === b.url &&
    a.state === b.state &&
    a.title === b.title)

const nothing = (): (() => void) => () => {}

/** The pull request of the work at `root`, kept fresh while the item shows. */
export const usePullRequest = (root: string): PullRequest | undefined => {
  const pulls = useContext(PullRequestsContext)
  useEffect(() => pulls?.follow(), [pulls])
  // The last answer, kept while an equal one comes, so the item draws again only on a change.
  const last = useRef<PullRequest | undefined>(undefined)
  const read = useCallback(() => {
    const next = pulls ? pullRequestAt(pulls.state.getSnapshot().works, root) : undefined
    if (!samePullRequest(last.current, next)) last.current = next
    return last.current
  }, [pulls, root])
  return useSyncExternalStore(pulls?.state.subscribe ?? nothing, read)
}
