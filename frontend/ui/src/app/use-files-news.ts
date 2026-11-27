import type { Backend } from "@novadeck/core/port"
import { useMemo, useState } from "react"

import { acknowledgedOf, filesNews, syncFeedOf, type Acknowledged } from "../sidebar/files-sync"
import { useRepoSync } from "../sidebar/useRepoSync"

const none: Acknowledged = new Map()

const same = (a: Acknowledged, b: Acknowledged): boolean =>
  a.size === b.size && [...a].every(([path, count]) => b.get(path) === count)

// What the open project's repositories hold that the person has yet to look at, in words, for the
// Files toggle's dot: main moved on in a repository, or was left behind. Undefined for none, and
// where the backend tells nothing of them. While the Files panel is open (`open`) what is behind is
// acknowledged, so a repository that stays behind for days lights the dot only once more, when it
// falls behind again or further; one that is no longer behind is forgotten.
export const useFilesNews = (
  backend: Pick<Backend, "files">,
  projectId: string,
  open: boolean,
): string | undefined => {
  const feed = useMemo(() => syncFeedOf(backend.files, projectId), [backend.files, projectId])
  const repos = useRepoSync(feed)
  const standing = useMemo(() => acknowledgedOf(repos), [repos])
  const [known, setKnown] = useState<{ readonly projectId: string; readonly counts: Acknowledged }>(
    {
      projectId,
      counts: none,
    },
  )
  const before = known.projectId === projectId ? known.counts : none
  const counts = open ? standing : new Map([...before].filter(([path]) => standing.has(path)))
  if (known.projectId !== projectId || !same(before, counts)) setKnown({ projectId, counts })
  return filesNews(repos, counts)
}
