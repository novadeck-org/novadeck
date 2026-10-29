import {
  itemIdOf,
  type Item,
  PlanUnwritableError,
  type Companions,
  type ItemContent,
  type PageTrouble,
  pageTroublesPerCall,
} from "@novadeck/core/items"
import type { CompanionWindowMeta, WorkspaceTarget } from "@novadeck/core/types"
import {
  harnesses,
  type AgentName,
  type CompanionItem as RunnerItem,
  type CompanionWindow as RunnerWindow,
  type ItemContent as RunnerContent,
  type PageTrouble as RunnerTrouble,
} from "@novadeck/protocol"
import { planUnwritable } from "@novadeck/protocol"
import { hasCode, type Runner } from "@novadeck/runner-client"

// The runner's companion items as the UI holds them: what agents show and the person
// attaches, each a pointer the runner keeps, and their content, which `content` reads
// from where they point whenever it changes. A plan in a file is written back through the
// runner; one in an agent's messages stays read-only.

// Agents by the names the person knows them by.
export const agentNames = Object.fromEntries(harnesses.map(({ id, name }) => [id, name])) as Record<
  AgentName,
  string
>

// An item as the workspace holds it; its session is where the workspace keeps it.
export const itemOf = ({ sessionId: _session, plan, id, ...item }: RunnerItem): Item => ({
  ...item,
  id: itemIdOf(id),
  plan: plan && { agent: agentNames[plan.agent], role: plan.role, source: plan.source },
})

export const windowOf = ({
  id,
  home,
  itemId,
  title,
  titleSource,
}: RunnerWindow): CompanionWindowMeta => ({
  id,
  home,
  itemId: itemIdOf(itemId),
  name: title,
  titleSource,
})

// What an item holds, as the pane shows it. A page loads live where the host can load
// it; a plan says itself whether it can be written and whether its agent has the skill.
export const contentOf = (content: RunnerContent, livePages: boolean): ItemContent => {
  if (content.state === "unavailable") return content
  const { stamp } = content
  const shown = content.content
  if (shown.kind === "page") {
    const { scroll, ...page } = shown
    return {
      state: "ready",
      stamp,
      content: { ...page, ...(scroll !== undefined && { scroll }), live: livePages },
    }
  }
  if (shown.kind === "plan") {
    const { changedAt: _changed, ...plan } = shown
    return { state: "ready", stamp, content: plan }
  }
  return { state: "ready", stamp, content: shown }
}

// What the runner holds no more.
const gone: ItemContent = { state: "unavailable", reason: "gone", size: null }

// Cut to `max` UTF-16 units, as the schema counts them, never in a surrogate pair.
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

// A trouble as the runner takes it: strings within the schema's lengths, numbers whole and
// in range, as a page that logs anything may send.
export const troubleOf = (trouble: PageTrouble): RunnerTrouble => {
  if (trouble.kind === "error")
    return {
      kind: "error",
      text: clip(trouble.text, 1024),
      source: clip(trouble.source, 2048),
      line: Number.isFinite(trouble.line) ? Math.max(0, Math.trunc(trouble.line)) : 0,
    }
  if (trouble.kind === "request")
    return {
      kind: "request",
      url: clip(trouble.url, 2048),
      status: Math.min(999, Math.max(0, Math.trunc(trouble.status) || 0)),
      what: clip(trouble.what, 32),
    }
  return { kind: "load", text: clip(trouble.text, 256) }
}

export const createRunnerCompanions = (
  runner: Pick<Runner["companions"], "content" | "openInProject" | "save" | "pageTrouble">,
  {
    livePages = false,
    picture,
    phone,
    inOrder = (_target, operation) => operation(),
  }: {
    readonly livePages?: boolean
    readonly picture?: Companions["picture"]
    readonly phone?: Companions["phone"]
    // Runs a call behind the person's earlier changes to the session's items; direct by
    // default.
    readonly inOrder?: <T>(target: WorkspaceTarget, operation: () => Promise<T>) => Promise<T>
  } = {},
): Companions => ({
  ...(livePages && picture ? { picture } : {}),
  ...(livePages && phone ? { phone } : {}),
  follow: (_target, itemId, { reveal }, on) => {
    let stream: ReturnType<typeof runner.content> | undefined
    let stopped = false
    try {
      stream = runner.content(itemId, reveal === undefined ? {} : { reveal })
    } catch {
      return () => {}
    }
    void (async () => {
      try {
        for await (const content of stream) if (!stopped) on(contentOf(content, livePages))
        // The stream ends on its own once the runner has the item no longer, as when it
        // was never there: it's gone.
        if (!stopped) on(gone)
      } catch (error) {
        // Anything else ends with the link.
        if (!stopped && hasCode(error, "NOT_FOUND")) on(gone)
      }
    })()
    return () => {
      stopped = true
      void stream?.return?.()
    }
  },
  save: async (_target, itemId, text, basedOn) => {
    const result = await runner.save({ itemId, text, basedOn }).catch((error: unknown) => {
      // A plan that can't be written says why; any other failure may pass.
      const why = hasCode(error, "PLAN_UNWRITABLE") && planUnwritable.safeParse(error.data)
      throw why && why.success ? new PlanUnwritableError(why.data.reason) : error
    })
    if (result.saved) return result
    const { stamp, ...plan } = result.current
    // Only a plan in a file is saved; one cut short is read-only.
    return {
      saved: false,
      current: { stamp, plan: { kind: "plan", ...plan, writable: !plan.truncated } },
    }
  },
  trouble: (_target, itemId, shown, troubles) => {
    if (troubles.length === 0) return
    // Best effort: the agent just doesn't hear of it if this fails.
    void Promise.resolve()
      .then(() =>
        runner.pageTrouble({
          itemId,
          shown,
          troubles: troubles.slice(0, pageTroublesPerCall).map(troubleOf),
        }),
      )
      .catch(() => {})
  },
  openInProject: async (target, path, windowId) => {
    const { item, window } = await inOrder(target, () =>
      runner.openInProject({ sessionId: target.workspaceSessionId, path, windowId }),
    )
    return { item: itemOf(item), window: windowOf(window) }
  },
})
