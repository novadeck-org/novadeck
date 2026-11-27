import type { Backend } from "@novadeck/core/port"
import { useMemo } from "react"

import { hasNews, syncFeedOf } from "../sidebar/files-sync"
import { useRepoSync } from "../sidebar/useRepoSync"

// What the open project's repositories hold that the person has yet to look at, in words, for the
// Files toggle's dot: main moved on in a repository, or was left behind. Undefined for none, and
// where the backend tells nothing of them.
export const useFilesNews = (
  backend: Pick<Backend, "files">,
  projectId: string,
): string | undefined => {
  const feed = useMemo(() => syncFeedOf(backend.files, projectId), [backend.files, projectId])
  const repos = useRepoSync(feed)
  const news = repos.filter(hasNews)
  if (news.length === 0) return undefined
  const landed = news.filter((repo) => repo.landing !== null).length
  const behind = news.filter((repo) => repo.behind !== null).length
  return [
    landed > 0 ? `${landed === 1 ? "main moved" : `main moved in ${landed} repositories`}` : "",
    behind > 0 ? `${behind === 1 ? "one is" : `${behind} are`} behind origin` : "",
  ]
    .filter(Boolean)
    .join(", ")
}
