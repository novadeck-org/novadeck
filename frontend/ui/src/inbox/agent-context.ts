import { agentContext, answersOf, type AgentContext } from "@novadeck/core/agents/steps"
import type { Conversation, Conversations } from "@novadeck/core/conversation"
import type { Refused } from "@novadeck/core/conversation/prompt-refusal"
import type { InboxRow } from "@novadeck/core/inbox"
import type { Messages, TerminalThreads } from "@novadeck/core/messages"
import { terminalKeyPath } from "@novadeck/core/types"
import type { Diagnostics } from "@novadeck/requests/RequestCard"
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
  readonly conversations?:
    | (Pick<Conversations, "conversation"> & Partial<Pick<Conversations, "refused" | "saveDialog">>)
    | undefined
  // Shows the logs folder, where the desktop app has one.
  readonly openLogs?: (() => void) | undefined
  readonly messages?: Pick<Messages, "state"> | undefined
}

const AgentSources = createContext<Sources>({})

export const AgentContextProvider = ({
  children,
  ...sources
}: Sources & { readonly children?: ReactNode }): React.JSX.Element => {
  const { conversations, messages, openLogs } = sources
  const value = useMemo(
    () => ({ conversations, messages, openLogs }),
    [conversations, messages, openLogs],
  )
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

const refusesNothing: Refused = () => false

// Whether words that go on as an agent's next prompt would be refused for their shape, as the
// backend says, the chat's own check; outside the app nothing is.
export const useRefused = (): Refused =>
  useContext(AgentSources).conversations?.refused ?? refusesNothing

// What the Inbox's card of a request whose dialog no adapter read does for the person's bug report:
// saves it to a file, and shows the logs folder; undefined where the backend can't save one.
export const useDiagnostics = (row: InboxRow, request: string): Diagnostics | undefined => {
  const { conversations, openLogs } = useContext(AgentSources)
  const { projectId, workspaceSessionId, terminalId } = row.source
  const save = conversations?.saveDialog
  return useMemo(
    () =>
      save && {
        save: () => save({ projectId, workspaceSessionId, terminalId }, request),
        open: openLogs,
      },
    [save, openLogs, projectId, workspaceSessionId, terminalId, request],
  )
}
