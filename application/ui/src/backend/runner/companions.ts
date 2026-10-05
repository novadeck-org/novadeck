import type {
  AgentName,
  CompanionItem as RunnerItem,
  CompanionWindow as RunnerWindow,
  ItemContent as RunnerContent,
} from "@novadeck/protocol"
import { hasCode, type Runner } from "@novadeck/protocol/client"

import {
  itemIdOf,
  type CompanionItem,
  type Companions,
  type ItemContent,
} from "../../model/companion"
import type { CompanionWindowMeta } from "../../model/types"

// The runner's companion items as the UI holds them: what agents show and the person
// attaches, each a pointer the runner keeps, and their content, which `content` reads
// from where they point whenever it changes. Plans are read-only for now: the runner
// can't write one yet.

// Agents by the names the person knows them by.
export const agentNames: Record<AgentName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
}

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
// it; a plan can't be written, and Novadeck can't tell yet whether its skill is there.
export const contentOf = (content: RunnerContent, livePages: boolean): ItemContent => {
  if (content.state === "unavailable") return content
  const { stamp } = content
  const shown = content.content
  if (shown.kind === "page")
    return { state: "ready", stamp, content: { ...shown, live: livePages } }
  if (shown.kind === "plan") {
    const { changedAt: _changed, ...plan } = shown
    return { state: "ready", stamp, content: { ...plan, writable: false, skill: false } }
  }
  return { state: "ready", stamp, content: shown }
}

// What the runner holds no more.
const gone: ItemContent = { state: "unavailable", reason: "gone", size: null }

export const createRunnerCompanions = (
  runner: Pick<Runner["companions"], "content" | "attach">,
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
  save: () => Promise.reject(new Error("The runner can't write plans yet")),
  attach: async ({ terminalId }, path) => {
    await runner.attach({ terminalId, path })
  },
})
