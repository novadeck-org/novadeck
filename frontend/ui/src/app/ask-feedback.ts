import { isWindow } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"

import { openAskAgent } from "../feedback/ask-agent-state"
import type { AskFeedback } from "../terminals/window-menu"
import { isAgentTerminal } from "../voice/agent-terminal"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentTarget, sameTarget } from "./selectors"

// What a window's menu offers to ask its agent for feedback: only a terminal running an agent
// that has a handle, on a backend whose feedback can ask an agent. Undefined for anything else.
export const useAskFeedback = (tile: Tile): AskFeedback | undefined => {
  const { backend } = useWorkspaceServices()
  const target = useWorkspaceState(currentTarget, sameTarget)
  if (!backend.feedback?.ask || isWindow(tile) || !tile.handle || !isAgentTerminal(tile))
    return undefined
  const { handle } = tile
  return {
    handle,
    onAsk: () => openAskAgent({ key: { ...target, terminalId: tile.id }, handle }),
  }
}
