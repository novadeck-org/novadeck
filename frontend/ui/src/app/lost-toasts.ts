import type { AgentName } from "@novadeck/core/harnesses"
import type { Backend } from "@novadeck/core/port"

import type { LostBoard } from "../inbox/InboxToasts"
import { agentLabels } from "../preferences/agent-switches"
import { hasVoice } from "./project-windows"
import type { UiStore } from "./ui-store"

// What the toast of a lost agent says: what happened, and what it keeps from working.
export const lostTitle = (agent: AgentName): string =>
  `${agentLabels[agent]} is no longer connected`
export const lostWords =
  "Its sleeping agents can't wake and its sessions can't resume until you reconnect it."

// Tells the person of each agent that goes lost (`AgentConnection.lost`): Novadeck's plugin was
// taken from it outside Novadeck, or it isn't connected while agents of it sleep. Once per agent
// per run, the first value seen included, and again only after it was connected in between. The
// toast goes with the loss (the person, or another client, connects the agent). Only the window
// the person used last speaks, as with the ding, so several windows tell it once; every window
// still counts the loss as told, so one that gets the voice later doesn't repeat it.
export const watchLostToasts = (
  agents: Backend["agents"],
  ui: UiStore,
  board: LostBoard,
  {
    reconnect,
    open,
  }: {
    readonly reconnect: (agent: AgentName) => void
    readonly open: (agent: AgentName) => void
  },
): (() => void) => {
  if (!agents) return () => {}
  const told = new Set<AgentName>()
  const look = (): void => {
    for (const each of agents.state.getSnapshot()) {
      const { agent } = each
      if (each.lost && !each.connected) {
        if (told.has(agent)) continue
        told.add(agent)
        if (!hasVoice(ui.getSnapshot())) continue
        board.show({
          agent,
          title: lostTitle(agent),
          words: lostWords,
          reconnect: () => {
            board.close(agent)
            reconnect(agent)
          },
          open: () => {
            board.close(agent)
            open(agent)
          },
        })
      } else if (each.connected) {
        // Connected again: a later loss is news.
        told.delete(agent)
        board.close(agent)
      }
    }
  }
  look()
  return agents.state.subscribe(look)
}
