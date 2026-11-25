import { staleFetchMs } from "@novadeck/core/fetch-age"
import type { OriginFailing } from "@novadeck/core/works"
import { useCallback, useEffect, useMemo, useState } from "react"

import type { FooterOriginProps } from "../shell/FooterOrigin"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useWorktreesShown } from "./use-worktrees-shown"

// How often the footer asks the backend again which origins fail: the runner answers from what
// its own fetches left, with no git run.
export const originPollMs = 20_000

type Reads = ReadonlyMap<string, readonly OriginFailing[]>

const noReads: Reads = new Map()

const same = (a: readonly OriginFailing[] | undefined, b: readonly OriginFailing[]): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b)

// The origins that have failed long enough to say so, of those the backend named at `now`.
export const longFailing = (
  failing: readonly OriginFailing[],
  now: number,
): readonly OriginFailing[] => failing.filter((each) => now - each.since >= staleFetchMs)

// The open project's origins that have kept failing to fetch for an hour or more, for the footer's
// chip; undefined where there are none, the backend can't tell, or the worktrees aren't shown
// (`useWorktreesShown`), as only they are measured against origin. Each project's answer is kept
// apart, so one that comes late, after a switch, says nothing of the project open now; and an
// answer the same as the last changes nothing, so the footer isn't drawn again for it.
export const useFailingOrigins = (): FooterOriginProps | undefined => {
  const { backend } = useWorkspaceServices()
  const shown = useWorktreesShown()
  const projectId = useWorkspaceState((workspace) => workspace.activeProjectId)
  const works = shown ? backend.works : undefined
  const origins = works?.origins
  const fetch = works?.fetch
  const [reads, setReads] = useState<Reads>(noReads)
  const readNow = useCallback(
    (): Promise<void> | undefined =>
      origins?.(projectId)
        .catch(() => [])
        .then((answer) => {
          const failing = longFailing(answer, Date.now())
          setReads((before) =>
            same(before.get(projectId), failing) ? before : new Map(before).set(projectId, failing),
          )
        }),
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
    const failing = reads.get(projectId)
    if (!origins || !fetch || !failing || failing.length === 0) return undefined
    return { projectId, failing, onRetry }
  }, [origins, fetch, reads, projectId, onRetry])
}
