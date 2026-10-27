import type { InboxRow } from "@novadeck/core/inbox"
import { planItemOf, planKey, planTextOf, sessionItems } from "@novadeck/core/inbox-plan"
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

type PlanSource = {
  readonly workspace: WorkspaceStore
  readonly companions: Companions
  // The plan version each approval's sheet shows (Inbox item id to `planKey`).
  readonly showing: Map<string, string>
  // The versions an approval was answered with (`planKey` to the Inbox item's id): one the
  // person approved or sent back is never a later approval's. A version only shown counts for
  // nothing, as a dialog read again (a redraw) comes back as a new item asking the same.
  readonly answered: Map<string, string>
}

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
    () =>
      companions
        ? {
            workspace,
            companions,
            showing: new Map<string, string>(),
            answered: new Map<string, string>(),
          }
        : undefined,
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
  const pick = useMemo(() => {
    const answered = source?.answered
    const used = new Set(
      answered ? [...answered].filter(([, by]) => by !== item.id).map(([key]) => key) : [],
    )
    return planItemOf(items, item, now, used)
  }, [source, items, item, now])
  const until = pick.state === "waiting" ? pick.until : undefined
  useEffect(() => {
    if (until === undefined) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()))
    return () => clearTimeout(timer)
  }, [until])

  // Followed anew for each version of the plan, so its text is never an earlier round's.
  const found = pick.state === "found" ? pick.item : undefined
  const key = found && planKey(found)
  // Which version this approval's sheet shows, for `usePlanAnswered` to record.
  useEffect(() => {
    if (key && source) source.showing.set(item.id, key)
  }, [key, source, item.id])
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

// Records that a plan approval was answered with the plan its sheet shows, so that version
// is never a later approval's plan (a round the person sent back, still on the bar while the
// agent rewrites it). The sheet calls it as it sends the answer.
export const usePlanAnswered = (): ((item: InboxRow) => void) => {
  const source = useContext(PlanContext)
  return useCallback(
    (item: InboxRow) => {
      const key = source?.showing.get(item.id)
      if (key && source && !source.answered.has(key)) source.answered.set(key, item.id)
    },
    [source],
  )
}
