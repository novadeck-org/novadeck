import type { RepoSync } from "@novadeck/core/files"
import { useEffect, useSyncExternalStore } from "react"

import type { SyncFeed } from "./files-sync"

const none: readonly RepoSync[] = []
const noStore = { getSnapshot: () => undefined, subscribe: () => () => {} }

// The repositories of the project and how they stand against their origins, following them for as
// long as the caller is mounted: whether or not the Files panel shows, as the rail's dot and the
// notices need them too.
export const useRepoSync = (feed: SyncFeed | undefined): readonly RepoSync[] => {
  useEffect(() => feed?.retain(), [feed])
  const state = useSyncExternalStore(
    (listener) => (feed?.store ?? noStore).subscribe(listener),
    () => (feed?.store ?? noStore).getSnapshot(),
  )
  return state?.repos ?? none
}
