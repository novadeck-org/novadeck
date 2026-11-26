import type { PullRequest } from "@novadeck/core/forges"
import type { Store } from "@novadeck/core/store"
import type { Work, WorksState } from "@novadeck/core/works"
import { useShown } from "@novadeck/toolkit/shown"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react"

// The pull request of the work a changes item shows, as the forges found it: the app's works,
// which carry each one's (see core's `works`). Outside the workspace, or where the backend has no
// works, there is none and the item shows no link.

export type PullRequests = {
  readonly state: Store<WorksState>
  // Whether pull requests are looked for now (a forge is on): while none is, the works' last word
  // on them is stale and no link shows.
  readonly on: Store<boolean>
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
const off = (): boolean => false

/**
 * The pull request of the work at `root`, kept fresh while the item is on screen: one kept mounted
 * out of sight, as Focus keeps the terminals it last showed, has the backend follow nothing.
 */
export const usePullRequest = (root: string): PullRequest | undefined => {
  const pulls = useContext(PullRequestsContext)
  const shown = useShown()
  useEffect(() => (shown ? pulls?.follow() : undefined), [pulls, shown])
  const on = useSyncExternalStore(pulls?.on.subscribe ?? nothing, pulls?.on.getSnapshot ?? off)
  // The last answer, kept while an equal one comes, so the item draws again only on a change.
  const last = useRef<PullRequest | undefined>(undefined)
  const read = useCallback(() => {
    const next = pulls ? pullRequestAt(pulls.state.getSnapshot().works, root) : undefined
    if (!samePullRequest(last.current, next)) last.current = next
    return last.current
  }, [pulls, root])
  const pull = useSyncExternalStore(pulls?.state.subscribe ?? nothing, read)
  return on ? pull : undefined
}
