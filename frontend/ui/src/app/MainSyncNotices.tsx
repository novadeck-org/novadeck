import { useEffect, useMemo, useRef, useState } from "react"

import { freshNotices, syncFeedOf } from "../sidebar/files-sync"
import { useRepoSync } from "../sidebar/useRepoSync"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { dingOf } from "./ding"
import { noticeBoard } from "./inbox-pings"

// Tells the person, while Novadeck is in the background, when main moved on in one of the open
// project's repositories with a pull request of one of their agents in it, or with new
// dependencies; it follows the same Preferences switch as an agent finishing. A landing the app
// found already there when it began, or saw while the page had focus, is no news.
export const MainSyncNotices = (): null => {
  const { backend, ui } = useWorkspaceServices()
  const projectId = useWorkspaceState((workspace) => workspace.activeProjectId)
  const feed = useMemo(() => syncFeedOf(backend.files, projectId), [backend.files, projectId])
  const repos = useRepoSync(feed)
  const [began] = useState(Date.now)
  const told = useRef(new Set<string>())
  useEffect(() => {
    const board = noticeBoard(backend.notices, dingOf(backend, ui))
    const { pageFocused, preferences } = ui.getSnapshot()
    for (const notice of freshNotices(
      repos,
      told.current,
      began,
      board !== undefined && !pageFocused && preferences.notifyFinished,
    ))
      board?.show("main", notice)
  }, [backend, ui, repos, began])
  return null
}
