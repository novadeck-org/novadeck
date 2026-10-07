import {
  noConversation,
  type ChatItem,
  type Conversation,
  type Conversations,
} from "../../model/conversation"
import { promptRefusal, promptRefused } from "../../model/prompt-refusal"
import type { WorkspaceSeed } from "../../model/seed"
import { createStore, type MutableStore } from "../../model/store"
import type { AgentStatus, TerminalMetadata, Workspace } from "../../model/types"
import type { TerminalKey } from "../port"
import { terminalKeyId } from "../registry"
import { chatAgent, chatAgents } from "./samples"
import type { DemoTranscript } from "./transcripts"
import type { DemoTurns, TurnEvent } from "./turns"

export type DemoChat = {
  readonly conversations: Conversations
  // Takes the workspace as it stands, which tells what each terminal runs.
  readonly observe: (workspace: Workspace) => void
}

type Found = { readonly key: TerminalKey; readonly terminal: TerminalMetadata }

const agentOf = (terminal: TerminalMetadata): AgentStatus =>
  terminal.state === "running" ? (terminal.agent ?? { working: false }) : { working: false }

const runs = (found: Found | undefined): found is Found =>
  found !== undefined &&
  found.terminal.state === "running" &&
  chatAgent(found.terminal) !== undefined

const text = (role: ChatItem["role"], value: string) => ({
  role,
  kind: "text" as const,
  text: value,
  tool: null,
  call: null,
  author: null,
})

// What each demo agent's tool does as its turn runs, by harness.
const toolRun = (agent: string, terminal: TerminalMetadata, call: string) =>
  agent === "agy"
    ? {
        tool: "run_command",
        input: JSON.stringify({
          CommandLine: JSON.stringify("git status --short"),
          Cwd: JSON.stringify(terminal.directory),
          toolAction: JSON.stringify("Running git status"),
        }),
        output: "Exit code: 0\nOutput:\n M src/runtime/server.ts\n",
        call,
      }
    : agent === "codex"
      ? {
          tool: "exec_command",
          input: JSON.stringify({
            cmd: "git status --short",
            workdir: terminal.directory,
          }),
          output:
            "Chunk ID: 3f9c1a\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\n M src/checkout/total.ts\n",
          call,
        }
      : {
          tool: "Bash",
          input: JSON.stringify({
            command: "git status --short",
            description: "Show what changed",
          }),
          output: " M src/checkout/total.ts",
          call,
        }

// The demo's conversations: each terminal running Claude Code or Codex opens with its
// `transcripts` entry, and a prompt sent to it drives the same simulated turn as one typed
// in its screen, which `turns` runs. Only terminals idle at their prompt take a prompt.
export const createDemoChat = (
  seed: WorkspaceSeed,
  transcripts: Readonly<Record<string, DemoTranscript>>,
  turns: DemoTurns,
): DemoChat => {
  let latest: Workspace | undefined
  const stores = new Map<string, { key: TerminalKey; store: MutableStore<Conversation> }>()
  // The terminal at the full address, in the workspace as it stands, or in the seed.
  const locate = (key: TerminalKey): Found | undefined => {
    const terminals = latest
      ? latest.projects
          .find((project) => project.id === key.projectId)
          ?.history.find((session) => session.id === key.workspaceSessionId)?.state.roster.terminals
      : seed.projects
          .find((project) => project.id === key.projectId)
          ?.sessions.find((session) => session.id === key.workspaceSessionId)?.terminals
    const terminal = terminals?.find((each) => each.id === key.terminalId)
    return terminal ? { key, terminal } : undefined
  }
  const opened = (found: Found | undefined): Conversation => {
    if (!runs(found)) return noConversation
    // The sample transcripts belong to the first project's terminals, as the engine's
    // sample terminals do; another project's agents start empty.
    const transcript =
      found.key.projectId === seed.projects[0]?.id ? transcripts[found.terminal.id] : undefined
    return {
      agent: found.terminal.process,
      session: `demo-${terminalKeyId(found.key)}`,
      loaded: true,
      items: transcript?.items ?? [],
      requests: transcript?.requests ?? [],
    }
  }
  const storeOf = (key: TerminalKey): MutableStore<Conversation> => {
    const id = terminalKeyId(key)
    const existing = stores.get(id)
    if (existing) return existing.store
    const store = createStore(opened(locate(key)))
    stores.set(id, { key, store })
    return store
  }
  const append = (key: TerminalKey, ...drafts: Omit<ChatItem, "id" | "at" | "truncated">[]) =>
    storeOf(key).update((conversation) => ({
      ...conversation,
      items: [
        ...conversation.items,
        ...drafts.map((draft, index) => ({
          ...draft,
          id: `${terminalKeyId(key)}:${conversation.items.length + index + 1}`,
          at: Date.now(),
          truncated: false,
        })),
      ],
    }))
  turns.watch((event: TurnEvent) => {
    const { key } = event
    if (event.type === "begin") append(key, text("user", event.prompt))
    else if (event.type === "tool") {
      const found = locate(key)
      if (!found) return
      const items = storeOf(key).getSnapshot().items
      const run = toolRun(
        String(found.terminal.process),
        found.terminal,
        `demo-call-${items.length}`,
      )
      append(
        key,
        {
          role: "assistant",
          kind: "tool-call",
          text: run.input,
          tool: run.tool,
          call: run.call,
          author: null,
        },
        {
          role: "tool",
          kind: "tool-result",
          text: run.output,
          tool: null,
          call: run.call,
          author: null,
        },
      )
    } else if (event.outcome === "completed" && event.reply) {
      append(key, text("assistant", event.reply))
    } else {
      // A refused request is answered.
      storeOf(key).update((conversation) =>
        conversation.requests.length ? { ...conversation, requests: [] } : conversation,
      )
    }
  })
  const agentFor = (key: TerminalKey): Found => {
    const found = locate(key)
    if (!runs(found))
      throw new Error(
        "No agent is running in this terminal. Start Claude Code, Codex or Antigravity in it first.",
      )
    return found
  }
  return {
    conversations: {
      conversation: storeOf,
      send: async (key, prompt) => {
        const found = agentFor(key)
        const name = chatAgents[chatAgent(found.terminal)!]
        const agent = agentOf(found.terminal)
        if (agent.attention)
          throw new Error(
            `${name} is waiting for your answer in its terminal. Answer it there first.`,
          )
        if (agent.working || turns.working(found.key))
          throw new Error(`${name} is still working. Stop it or wait until it finishes.`)
        if (!prompt.trim()) return
        // As the runner refuses it: text the agent would read as more than a message.
        if (promptRefused(prompt)) throw new Error(promptRefusal)
        turns.prompt(prompt, found.terminal, found.key)
      },
      interrupt: async (key) => {
        const found = agentFor(key)
        turns.interrupt(found.key, agentOf(found.terminal))
        // The demo queues nothing behind a turn: nothing comes back.
        return null
      },
    },
    observe: (workspace) => {
      latest = workspace
      for (const { key, store } of stores.values()) {
        const found = locate(key)
        store.update((conversation) => {
          if (!runs(found)) return conversation.agent === null ? conversation : noConversation
          if (conversation.agent === null) return opened(found)
          // Nothing waits once the agent has nothing to ask.
          return !agentOf(found.terminal).attention && conversation.requests.length
            ? { ...conversation, requests: [] }
            : conversation
        })
      }
    },
  }
}
