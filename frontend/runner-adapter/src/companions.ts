import {
  itemIdOf,
  type CompanionItem,
  PlanUnwritableError,
  type Companions,
  type ItemContent,
} from "@novadeck/core/companion"
import type { CompanionWindowMeta } from "@novadeck/core/types"
import {
  harnesses,
  type AgentName,
  type CompanionItem as RunnerItem,
  type CompanionWindow as RunnerWindow,
  type ItemContent as RunnerContent,
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
export const itemOf = ({ sessionId: _session, plan, id, ...item }: RunnerItem): CompanionItem => ({
  ...item,
  id: itemIdOf(id),
  plan: plan && { agent: agentNames[plan.agent], role: plan.role, source: plan.source },
})

export const windowOf = ({
  id,
  itemId,
  title,
  titleSource,
}: RunnerWindow): CompanionWindowMeta => ({
  id,
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
  if (shown.kind === "page")
    return { state: "ready", stamp, content: { ...shown, live: livePages } }
  if (shown.kind === "plan") {
    const { changedAt: _changed, ...plan } = shown
    return { state: "ready", stamp, content: plan }
  }
  return { state: "ready", stamp, content: shown }
}

// What the runner holds no more.
const gone: ItemContent = { state: "unavailable", reason: "gone", size: null }

export const createRunnerCompanions = (
  runner: Pick<Runner["companions"], "content" | "attach" | "save">,
  { livePages = false }: { readonly livePages?: boolean } = {},
): Companions => ({
  follow: (_target, itemId, { reveal }, on) => {
    let stream: ReturnType<typeof runner.content> | undefined
    let stopped = false
    try {
      stream = runner.content(itemId, { reveal })
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
  attach: async ({ terminalId }, path) => {
    await runner.attach({ terminalId, path })
  },
})
