import {
  agentContext,
  handoffsOf,
  type AgentContext,
  type AgentStep,
} from "@novadeck/core/agent-steps"
import type { Conversation, Conversations } from "@novadeck/core/conversation"
import type { InboxRow, InboxSource } from "@novadeck/core/inbox"
import { companionKeyId } from "@novadeck/core/items"
import type { Messages, TerminalThreads } from "@novadeck/core/messages"
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
// the same for Claude Code, Codex and Antigravity: see `@novadeck/core/agent-steps`.

// One step: a tool call that edited, ran or failed, in the harness's own words: the tool's
// name as the harness gave it ("Edit", "Bash", "apply_patch"), its argument on one line (a
// path, a command), and what came of it, where known: "+4 −2" for an edit, a short line for
// a run, the error.
//
// The agent's context: the last words it was given, and who gave them (`by` null for the
// person, a lead's handle, bare, no @, for a teammate's handoff), and at most three steps,
// oldest first.
export type { AgentContext, AgentStep }

// Where the Inbox reads agents' context from: the backend's conversations and messages, and
// the lead of an item's terminal, whose messages count as its agent's words. Absent outside
// the app, as in a sheet's tests: there is no context then.
type Sources = {
  readonly conversations?: Conversations | undefined
  readonly messages?: Messages | undefined
  readonly leadOf?: ((source: InboxSource) => string | null) | undefined
}

const AgentSources = createContext<Sources>({})

export const AgentContextProvider = ({
  children,
  ...sources
}: Sources & { readonly children?: ReactNode }): React.JSX.Element => {
  const { conversations, messages, leadOf } = sources
  const value = useMemo(
    () => ({ conversations, messages, leadOf }),
    [conversations, messages, leadOf],
  )
  return createElement(AgentSources.Provider, { value }, children)
}

const nothing = () => () => {}
const none = () => undefined

// The agent's context for an item's sheet, read while the sheet shows it: undefined while it
// loads or where there's no transcript (a plain shell). Its conversation is followed only
// while a sheet calls this, as the backend reads a transcript only for its subscribers.
export const useAgentContext = (item: InboxRow): AgentContext | undefined => {
  const { conversations, messages, leadOf } = useContext(AgentSources)
  const { projectId, workspaceSessionId, terminalId } = item.source
  const store = useMemo(
    () => conversations?.conversation({ projectId, workspaceSessionId, terminalId }),
    [conversations, projectId, workspaceSessionId, terminalId],
  )
  const conversation: Conversation | undefined = useSyncExternalStore(
    store?.subscribe ?? nothing,
    store?.getSnapshot ?? none,
  )
  const id = companionKeyId({ projectId, workspaceSessionId, terminalId })
  const threads: TerminalThreads | undefined = useSyncExternalStore(
    messages?.state.subscribe ?? nothing,
    () => messages?.state.getSnapshot().terminals[id],
  )
  const lead = leadOf?.(item.source) ?? null
  return useMemo(() => {
    if (!conversation?.loaded || conversation.agent === null) return undefined
    return agentContext(conversation.agent, conversation.items, handoffsOf(threads, lead))
  }, [conversation, threads, lead])
}
