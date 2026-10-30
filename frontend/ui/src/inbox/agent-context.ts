import {
  agentContext,
  answersOf,
  type AgentContext,
  type AgentStep,
} from "@novadeck/core/agents/steps"
import type { Conversation, Conversations } from "@novadeck/core/conversation"
import type { InboxRow } from "@novadeck/core/inbox"
import type { Messages, TerminalThreads } from "@novadeck/core/messages"
import { terminalKeyPath } from "@novadeck/core/types"
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react"

// What a sheet shows to get the person back into an agent's task: their last words to it
// and the few steps it took since. Read from the agent's transcript (`agents.transcript`),
// the same for Claude Code, Codex and Antigravity: see `@novadeck/core/agents/steps`.

// One step: a tool call that edited, ran or failed, in the harness's own words: the tool's
// name as the harness gave it ("Edit", "Bash", "apply_patch"), its argument on one line (a
// path, a command), and what came of it, where known: "+4 −2" for an edit, a short line for
// a run, the error.
//
// The agent's context: the person's last words to it, never another agent's, and at most
// three steps, oldest first.
export type { AgentContext, AgentStep }

// Where the Inbox reads agents' context from: the backend's conversations and messages.
// Absent outside the app, as in a sheet's tests: there is no context then.
type Sources = {
  readonly conversations?: Conversations | undefined
  readonly messages?: Messages | undefined
}

const AgentSources = createContext<Sources>({})

export const AgentContextProvider = ({
  children,
  ...sources
}: Sources & { readonly children?: ReactNode }): React.JSX.Element => {
  const { conversations, messages } = sources
  const value = useMemo(() => ({ conversations, messages }), [conversations, messages])
  return createElement(AgentSources.Provider, { value }, children)
}

const nothing = () => () => {}
const none = () => undefined

// The agent's context for an item's sheet, read while the sheet shows it: undefined while it
// loads or where there's no transcript (a plain shell). Its conversation is followed only
// while a sheet calls this, as the backend reads a transcript only for its subscribers.
export const useAgentContext = (item: InboxRow): AgentContext | undefined => {
  const { conversations, messages } = useContext(AgentSources)
  const { projectId, workspaceSessionId, terminalId } = item.source
  const store = useMemo(
    () => conversations?.conversation({ projectId, workspaceSessionId, terminalId }),
    [conversations, projectId, workspaceSessionId, terminalId],
  )
  const conversation: Conversation | undefined = useSyncExternalStore(
    store?.subscribe ?? nothing,
    store?.getSnapshot ?? none,
  )
  const id = terminalKeyPath({ projectId, workspaceSessionId, terminalId })
  const threads: TerminalThreads | undefined = useSyncExternalStore(
    messages?.state.subscribe ?? nothing,
    () => messages?.state.getSnapshot().terminals[id],
  )
  return useMemo(() => {
    if (!conversation?.loaded || conversation.agent === null) return undefined
    return agentContext(conversation.agent, conversation.items, answersOf(threads))
  }, [conversation, threads])
}
