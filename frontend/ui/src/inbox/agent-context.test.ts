import {
  noConversation,
  type ChatItem,
  type Conversation,
  type Conversations,
} from "@novadeck/core/conversation"
import type { InboxRow } from "@novadeck/core/inbox"
import { companionKeyId } from "@novadeck/core/items"
import {
  noMessages,
  type MessageParty,
  type Messages,
  type MessagesState,
} from "@novadeck/core/messages"
import { createStore, type MutableStore } from "@novadeck/core/store"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

import { describe, expect, it } from "../test"
import { AgentContextProvider, useAgentContext, type AgentContext } from "./agent-context"

const agent = (handle: string): MessageParty => ({ kind: "agent", handle, agent: null })

const source = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "owl",
  agent: "claude",
  title: "Title",
  projectName: "Project",
} as const

const row: InboxRow = {
  id: "i",
  source,
  at: 0,
  stopped: true,
  seen: false,
  kind: "trouble",
  trouble: { type: "failed", error: null },
}

const item = (fields: Partial<ChatItem>): ChatItem => ({
  id: String(Math.random()),
  at: 1,
  role: "user",
  kind: "text",
  text: "",
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  interrupted: false,
  ...fields,
})

const transcript: readonly ChatItem[] = [
  item({ text: "[Novadeck: automatic notice, agent messages waiting, AbC123]", at: 10 }),
  item({
    role: "assistant",
    kind: "tool-call",
    tool: "Bash",
    call: "c",
    at: 11,
    text: JSON.stringify({ command: "pnpm test" }),
    run: { kind: "run", title: "Ran", detail: "pnpm test" },
  }),
  item({ role: "tool", kind: "tool-result", call: "c", at: 12, text: "Tests  48 passed (48)" }),
]

// A backend's conversation of the item's terminal, counting who follows it, and its messages.
const backend = () => {
  const conversation = createStore<Conversation>(noConversation)
  let following = 0
  const conversations = {
    conversation: () => ({
      getSnapshot: conversation.getSnapshot,
      subscribe: (listener: () => void) => {
        following += 1
        const stop = conversation.subscribe(listener)
        return () => {
          following -= 1
          stop()
        }
      },
    }),
  } as unknown as Conversations
  const messages: MutableStore<MessagesState> = createStore<MessagesState>({
    ...noMessages,
    terminals: {
      [companionKeyId(source)]: {
        handle: "owl",
        agent: true,
        threads: [
          {
            id: "th",
            peer: agent("crow"),
            hops: 1,
            idle: 0,
            held: false,
            heldFor: null,
            messages: [
              {
                id: "m",
                hop: 1,
                from: { kind: "person" },
                to: agent("owl"),
                text: "run the suite and report",
                sentAt: 8,
                state: "delivered",
                held: null,
                deliveredAt: 9,
                inbox: "answer",
              },
              // Its lead's, later: an agent's words, never quoted as the person's.
              {
                id: "n",
                hop: 1,
                from: agent("crow"),
                to: agent("owl"),
                text: "and plot the timings",
                sentAt: 10,
                state: "delivered",
                held: null,
                deliveredAt: 11,
              },
            ],
          },
        ],
      },
    },
  })
  return {
    conversation,
    conversations,
    messages: { state: messages } as unknown as Messages,
    following: () => following,
  }
}

// What the hook gives for the item, each time it renders.
const mount = (sources: Omit<Parameters<typeof AgentContextProvider>[0], "children"> | null) => {
  const seen: (AgentContext | undefined)[] = []
  const Probe = () => {
    seen.push(useAgentContext(row))
    return null
  }
  const probe = createElement(Probe)
  return {
    seen,
    ...render(sources ? createElement(AgentContextProvider, sources, probe) : probe),
  }
}

describe("an Inbox item's agent context", () => {
  it("is none outside the app, with no backend to read it from", () => {
    const { seen, unmount } = mount(null)
    expect(seen.at(-1)).toBeUndefined()
    unmount()
  })

  it("waits for the transcript, then gives the person's Inbox answer and the steps since", () => {
    const { conversation, conversations, messages } = backend()
    const { seen, unmount } = mount({ conversations, messages })
    expect(seen.at(-1)).toBeUndefined()
    act(() => {
      conversation.update(() => ({
        agent: "claude",
        session: "x",
        loaded: true,
        items: transcript,
        requests: [],
      }))
    })
    expect(seen.at(-1)).toEqual({
      said: { text: "run the suite and report", at: 9 },
      steps: [{ kind: "run", tool: "Bash", arg: "pnpm test", result: "Tests  48 passed (48)" }],
    })
    unmount()
  })

  it("follows the conversation only while the sheet shows the item", () => {
    const { conversations, messages, following } = backend()
    const { unmount } = mount({ conversations, messages })
    expect(following()).toBe(1)
    unmount()
    expect(following()).toBe(0)
  })
})
