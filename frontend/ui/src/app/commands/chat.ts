import {
  createChatCommands as createChatWrites,
  type ChatCommands as ChatWrites,
} from "@novadeck/chat/commands"
import { answerInTerminal } from "@novadeck/chat/state"
import type { TerminalKey } from "@novadeck/core/port"
import type { Workspace } from "@novadeck/core/types"

import { currentContext, currentState } from "../selectors"
import type { CommandContext } from "./context"
import { shellEdits } from "./shell"

// With the chat view on, a terminal's agent shows as a conversation, or as the terminal's
// screen while the person answers it there. The chat's own commands are its writes.
export type ChatCommands = ChatWrites & {
  // Shows the terminal's screen, as the person asks to answer the agent there, and types
  // there: its chat comes back once the agent no longer waits on them.
  readonly showTerminal: (terminalId: string) => void
}

// Whether the terminal is still in its session.
const terminalOpen = (snapshot: Workspace, key: TerminalKey): boolean =>
  snapshot.projects
    .find((project) => project.id === key.projectId)
    ?.history.find((session) => session.id === key.workspaceSessionId)
    ?.state.roster.terminals.some((terminal) => terminal.id === key.terminalId) === true

export const createChatCommands = (ctx: CommandContext): ChatCommands => {
  const { workspace, navigation, conversations, chat } = ctx
  const { set } = shellEdits(ctx)
  return {
    ...createChatWrites({
      chat,
      conversations,
      terminalOpen: (key) => terminalOpen(workspace.getSnapshot(), key),
      context: () => currentContext(workspace.getSnapshot()),
    }),
    showTerminal: (terminalId) => {
      const snapshot = workspace.getSnapshot()
      const { roster, view } = currentState(snapshot)
      if (!roster.terminals.some((each) => each.id === terminalId)) return
      answerInTerminal(chat, currentContext(snapshot), terminalId)
      // The surface takes keyboard focus, for the person's answer.
      navigation.go({ terminal: terminalId })
      set("keyboardFocus", { id: terminalId, view })
    },
  }
}
