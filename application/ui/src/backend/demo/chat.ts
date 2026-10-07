import {
  noConversation,
  type ChatItem,
  type ChatRequest,
  type Conversation,
  type Conversations,
} from "../../model/conversation"
import { promptRefusal, promptRefused, shellCommand } from "../../model/prompt-refusal"
import type { WorkspaceSeed } from "../../model/seed"
import { createStore, type MutableStore } from "../../model/store"
import type { AgentStatus, TerminalMetadata, Workspace } from "../../model/types"
import type { TerminalKey } from "../port"
import { terminalKeyId } from "../registry"
import { chatAgent, chatAgents } from "./samples"
import type { DemoDraft, DemoTranscript } from "./transcripts"
import type { DemoTurns, TurnEvent } from "./turns"

export type DemoChat = {
  readonly conversations: Conversations
  // Takes the workspace as it stands, which tells what each terminal runs.
  readonly observe: (workspace: Workspace) => void
}

// How long an answer takes to reach the agent, in milliseconds.
export const answerMs = 400

// How long an answered request stays up, shown as answered, before the agent reports it
// settled, in milliseconds.
export const answeredMs = 500

type Found = { readonly key: TerminalKey; readonly terminal: TerminalMetadata }

const agentOf = (terminal: TerminalMetadata): AgentStatus =>
  terminal.state === "running" ? (terminal.agent ?? { working: false }) : { working: false }

const runs = (found: Found | undefined): found is Found =>
  found !== undefined &&
  found.terminal.state === "running" &&
  chatAgent(found.terminal) !== undefined

const draftOf = (draft: DemoDraft): Omit<ChatItem, "id" | "at" | "truncated"> => ({
  role: draft.role,
  kind: draft.kind,
  text: draft.text,
  tool: draft.tool ?? null,
  call: draft.call ?? null,
  author: draft.author ?? null,
})

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
  const stores = new Map<
    string,
    { key: TerminalKey; store: MutableStore<Conversation>; attended: boolean }
  >()
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
  const transcriptOf = (found: Found): DemoTranscript | undefined =>
    found.key.projectId === seed.projects[0]?.id ? transcripts[found.terminal.id] : undefined
  const opened = (found: Found | undefined): Conversation => {
    if (!runs(found)) return noConversation
    // The sample transcripts belong to the first project's terminals, as the engine's
    // sample terminals do; another project's agents start empty.
    const transcript = transcriptOf(found)
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
    const found = locate(key)
    // An agent that reported something to wait on has its requests go once it stops.
    stores.set(id, {
      key,
      store,
      attended: found !== undefined && agentOf(found.terminal).attention !== undefined,
    })
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
        if (promptRefused(prompt, { shell: true })) throw new Error(promptRefusal)
        const command = shellCommand(prompt)
        if (command !== undefined) {
          // A shell command runs without a turn. Antigravity keeps no record of it; the
          // others show the person's line and the run, as their transcripts hold them.
          if (chatAgent(found.terminal) !== "agy")
            append(
              found.key,
              text("user", `!${command}`),
              {
                role: "tool",
                kind: "tool-call",
                text: JSON.stringify({ command }),
                tool: "Bash",
                call: null,
                author: null,
              },
              {
                role: "tool",
                kind: "tool-result",
                text: "(Bash completed with no output)",
                tool: null,
                call: null,
                author: null,
              },
            )
          return
        }
        turns.prompt(prompt, found.terminal, found.key)
      },
      interrupt: async (key) => {
        const found = agentFor(key)
        turns.interrupt(found.key, agentOf(found.terminal))
        // The demo queues nothing behind a turn: nothing comes back.
        return null
      },
      answer: async (key, id, answer) => {
        const found = agentFor(key)
        const store = storeOf(found.key)
        const waiting = (): ChatRequest | undefined =>
          store.getSnapshot().requests.find((request) => request.id === id)
        const dialog = waiting()?.dialog
        if (!waiting()) throw new Error("That request is already answered.")
        const outcome = transcriptOf(found)?.outcomes?.[id]
        if (
          !dialog ||
          dialog.type === "raw" ||
          !outcome ||
          !{
            choices: ["choice"],
            questions: ["questions", "chat"],
            form: ["form"],
          }[dialog.type].includes(answer.type)
        )
          throw new Error("Couldn't answer that here. Answer it in the terminal.")
        if (dialog.id !== answer.dialog)
          throw new Error("The dialog changed — check it and answer again.")
        // Words that go on as a prompt are checked before anything is pressed.
        const asPrompt =
          (answer.type === "choice" &&
            dialog.type === "choices" &&
            dialog.options.find((option) => option.id === answer.option)?.text === "prompt") ||
          (answer.type === "chat" && dialog.type === "questions" && dialog.chat === "prompt")
        if (
          asPrompt &&
          (answer.type === "choice" || answer.type === "chat") &&
          promptRefused(answer.text ?? "")
        )
          throw new Error(promptRefusal)
        await new Promise((resolve) => setTimeout(resolve, answerMs))
        // Stopped meanwhile: the request went with the turn.
        if (!waiting()) throw new Error("That request is already answered.")
        const result = outcome(answer, dialog)
        store.update((conversation) => ({
          ...conversation,
          requests: conversation.requests.map((request) =>
            request.id === id ? { ...request, answered: true } : request,
          ),
        }))
        await new Promise((resolve) => setTimeout(resolve, answeredMs))
        store.update((conversation) => ({
          ...conversation,
          requests: conversation.requests.filter((request) => request.id !== id),
        }))
        append(found.key, ...result.items.map(draftOf))
        turns.resume(found.key, found.terminal, result)
      },
    },
    observe: (workspace) => {
      latest = workspace
      for (const entry of stores.values()) {
        const { key, store } = entry
        const found = locate(key)
        const attention = runs(found) && agentOf(found.terminal).attention !== undefined
        const gone = entry.attended && !attention
        entry.attended = attention
        store.update((conversation) => {
          if (!runs(found)) return conversation.agent === null ? conversation : noConversation
          if (conversation.agent === null) {
            entry.attended = agentOf(found.terminal).attention !== undefined
            return opened(found)
          }
          // Nothing waits once the agent has nothing to ask.
          return gone && conversation.requests.length
            ? { ...conversation, requests: [] }
            : conversation
        })
      }
    },
  }
}
