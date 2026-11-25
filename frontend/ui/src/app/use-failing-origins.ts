import { staleFetchMs } from "@novadeck/core/fetch-age"
import type { OriginFailing } from "@novadeck/core/works"
import { useCallback, useEffect, useMemo, useState } from "react"

import type { FooterOriginProps } from "../shell/FooterOrigin"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useWorktreesShown } from "./use-worktrees-shown"

// How often the footer asks the backend again which origins fail: the runner answers from what
// its own fetches left, with no git run.
export const originPollMs = 20_000

type Read = {
  readonly projectId: string
  readonly failing: readonly OriginFailing[]
  readonly at: number
}

// The open project's origins that have kept failing to fetch for an hour or more, for the footer's
// chip; undefined where there are none, the backend can't tell, or the worktrees aren't shown
// (`useWorktreesShown`), as only they are measured against origin.
export const useFailingOrigins = (): FooterOriginProps | undefined => {
  const { backend } = useWorkspaceServices()
  const shown = useWorktreesShown()
  const projectId = useWorkspaceState((workspace) => workspace.activeProjectId)
  const works = shown ? backend.works : undefined
  const origins = works?.origins
  const fetch = works?.fetch
  const [read, setRead] = useState<Read | undefined>(undefined)
  // Reads the project's failing origins now; an answer is kept as of when it came.
  const readNow = useCallback(
    (): Promise<void> | undefined =>
      origins?.(projectId)
        .catch(() => [])
        .then((failing) => setRead({ projectId, failing, at: Date.now() })),
    [origins, projectId],
  )
  useEffect(() => {
    if (!origins) return
    void readNow()
    const timer = setInterval(() => void readNow(), originPollMs)
    return () => clearInterval(timer)
  }, [origins, readNow])
  const onRetry = useCallback(async (): Promise<void> => {
    await fetch?.(projectId).catch(() => {})
    await readNow()
  }, [fetch, projectId, readNow])
  return useMemo(() => {
    // What was read of another project, before the switch, says nothing of this one.
    if (!origins || !fetch || read?.projectId !== projectId) return undefined
    const failing = read.failing.filter((each) => read.at - each.since >= staleFetchMs)
    return failing.length > 0 ? { failing, onRetry, now: read.at } : undefined
  }, [origins, fetch, read, projectId, onRetry])
}
