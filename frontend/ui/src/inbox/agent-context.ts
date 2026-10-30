import { agentContext, answersOf, type AgentContext } from "@novadeck/core/agents/steps"
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

// Where the Inbox reads agents' context from: the backend's conversations and messages.
// Absent outside the app, as in a sheet's tests: there is no context then.
type Sources = {
  readonly conversations?: Pick<Conversations, "conversation"> | undefined
  readonly messages?: Pick<Messages, "state"> | undefined
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

// The agent's context for a row's sheet, read while the sheet shows it: undefined while it
// loads or where there's no transcript (a plain shell). Its conversation is followed only
// while a sheet calls this, as the backend reads a transcript only for its subscribers.
export const useAgentContext = (row: InboxRow): AgentContext | undefined => {
  const { conversations, messages } = useContext(AgentSources)
  const { projectId, workspaceSessionId, terminalId } = row.source
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
