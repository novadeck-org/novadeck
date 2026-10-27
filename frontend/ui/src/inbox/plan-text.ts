import type { InboxRow } from "@novadeck/core/inbox"
import { planItemOf, planTextOf, sessionItems } from "@novadeck/core/inbox-plan"
import type { Companions, Item, ItemContent } from "@novadeck/core/items"
import type { WorkspaceStore } from "@novadeck/core/store"
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

// The plan an agent asks the person to approve, as the Markdown it wrote, for the plan
// sheet's box: Claude Code's plan file, Codex's proposed plan, Antigravity's implementation
// plan. Each is the asking terminal's plan item (`core/inbox-plan.ts` picks it), read as the
// plan pane reads it, through the backend's companions.

type PlanSource = { readonly workspace: WorkspaceStore; readonly companions: Companions }

const PlanContext = createContext<PlanSource | undefined>(undefined)

// Gives the Inbox's sheets the plans: the workspace's items, and the backend's companions
// that read them. Without companions there are no plans to show.
export const PlanTextProvider = ({
  workspace,
  companions,
  children,
}: {
  readonly workspace: WorkspaceStore
  readonly companions: Companions | undefined
  readonly children?: ReactNode
}): React.JSX.Element => {
  const value = useMemo(
    () => (companions ? { workspace, companions } : undefined),
    [workspace, companions],
  )
  return createElement(PlanContext.Provider, { value }, children)
}

const noWorkspace: WorkspaceStore["subscribe"] = () => () => {}
const noItems: readonly Item[] = []

// The plan of a plan-approval item: undefined while it loads, null where there is none.
export const usePlanText = (item: InboxRow): string | null | undefined => {
  const source = useContext(PlanContext)
  const { projectId, workspaceSessionId } = item.source
  const items = useSyncExternalStore(
    source?.workspace.subscribe ?? noWorkspace,
    useCallback(
      () =>
        source
          ? sessionItems(source.workspace.getSnapshot(), { projectId, workspaceSessionId })
          : noItems,
      [source, projectId, workspaceSessionId],
    ),
  )
  // Whether a plan may still come is a matter of time: looked at again once the wait is over.
  const [now, setNow] = useState(Date.now)
  const pick = useMemo(() => planItemOf(items, item, now), [items, item, now])
  const until = pick.state === "waiting" ? pick.until : undefined
  useEffect(() => {
    if (until === undefined) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()))
    return () => clearTimeout(timer)
  }, [until])

  // Followed anew for each version of the plan, so its text is never an earlier round's.
  const found = pick.state === "found" ? pick.item : undefined
  const key = found && `${found.id}:${found.version}`
  const [loaded, setLoaded] = useState<{ key: string; content: ItemContent }>()
  const companions = source?.companions
  const foundId = found?.id
  useEffect(() => {
    if (!companions || !foundId || !key) return
    return companions.follow(
      { projectId, workspaceSessionId },
      foundId,
      { reveal: undefined },
      (content) => setLoaded({ key, content }),
    )
  }, [companions, projectId, workspaceSessionId, foundId, key])

  if (pick.state === "none" || !source) return null
  if (pick.state === "waiting") return undefined
  return planTextOf(loaded && loaded.key === key ? loaded.content : undefined)
}
