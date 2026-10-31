import {
  noConversation,
  type ChatItem,
  type ChatRequest,
  type Conversation,
  type Conversations,
} from "@novadeck/core/conversation"
import { promptRefusal, shellCommand } from "@novadeck/core/conversation/prompt-refusal"
import type { TerminalKey } from "@novadeck/core/port"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import { createStore, type MutableStore } from "@novadeck/core/store"
import { terminalKeyId } from "@novadeck/core/terminals/registry"
import type { AgentStatus, TerminalMetadata, Workspace } from "@novadeck/core/types"

import { chatAgent, chatAgents, terminalSlot } from "../samples"
import { sessionOf } from "../workspace"
import { promptRefused } from "./prompt-refusal"
import { madeRequest, type DemoRequestOutcome } from "./requests"
import type { DemoDraft, DemoTranscript } from "./transcripts"
import type { DemoTurns, TurnEvent } from "./turns"

export type DemoChat = {
  readonly conversations: Conversations
  // How many items a terminal's conversation opened with: its transcript's, else none.
  readonly opening: (key: TerminalKey) => number
  // Takes the workspace as it stands, which tells what each terminal runs.
  readonly observe: (workspace: Workspace) => void
}

// How long an answer takes to reach the agent, in milliseconds.
export const answerMs = 400

// How long an answered request stays up, shown as answered, before the agent reports it
// settled, in milliseconds.
export const answeredMs = 500

const movedOn = "The agent moved on before your answer reached it."

// A line sent to an agent, and when the person sent it.
type Sent = { readonly text: string; readonly submittedAt: number }

// A prompt as the runner reads it once sent: line ends as `\n`, trimmed.
const sentText = (line: string): string => line.replace(/\r\n?/g, "\n").trim()

// Spends the marks of the Inbox lines that `line` is entirely made of, as the runner does: one
// line, or several in the order they were marked, joined by line breaks. Whether it was.
const spendMarks = (marks: string[] | undefined, line: string): boolean => {
  if (!marks) return false
  const text = sentText(line)
  const one = marks.indexOf(text)
  if (one >= 0) {
    marks.splice(one, 1)
    return true
  }
  const taken: number[] = []
  let rest = text
  let from = 0
  while (rest !== "") {
    const next = marks.findIndex(
      (mark, at) => at >= from && (rest === mark || rest.startsWith(`${mark}\n`)),
    )
    if (next < 0) return false
    taken.push(next)
    rest = rest.slice(marks[next]!.length + 1)
    from = next + 1
  }
  for (const at of taken.toReversed()) marks.splice(at, 1)
  return taken.length > 0
}
type Found = { readonly key: TerminalKey; readonly terminal: TerminalMetadata }

const agentOf = (terminal: TerminalMetadata): AgentStatus =>
  terminal.state === "running" ? (terminal.agent ?? { working: false }) : { working: false }

type Attention = NonNullable<AgentStatus["attention"]>

const sameAttention = (a: Attention | undefined, b: Attention | undefined): boolean =>
  a?.kind === b?.kind && a?.count === b?.count

// Whether Novadeck hears from the agent: it has reported a status. One that hasn't, such
// as Antigravity, has what it waits on read from its screen instead.
const heard = (found: Found | undefined): boolean =>
  found?.terminal.state === "running" && found.terminal.agent !== undefined

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
  run: draft.run ?? null,
  interrupted: false,
})

const text = (role: ChatItem["role"], value: string) => ({
  role,
  kind: "text" as const,
  text: value,
  tool: null,
  call: null,
  author: null,
  run: null,
  interrupted: false,
})

// The line the chat shows for that command, in every harness.
const gitStatus = { kind: "run", title: "Ran", detail: "git status --short" } as const

// What an item carries of a text, as the runner takes it: cut at 16 KiB and marked.
const bounded = (full: string): { text: string; truncated: boolean } => ({
  text: full.slice(0, 16_384),
  truncated: full.length > 16_384,
})

// A shell command's call as the decoders' `shellCall` reads it from the item's own, cut input:
// a command that is itself JSON-quoted loses the quotes, only its first line shows, and a
// command too long for an item, whose cut input no longer parses, has no detail.
const shellCall = (command: string) => {
  const input = bounded(JSON.stringify({ command }))
  let shown = ""
  try {
    const parsed = (JSON.parse(input.text) as { command?: unknown }).command
    if (typeof parsed === "string") {
      shown = parsed
      const unquoted: unknown = (() => {
        try {
          return JSON.parse(parsed)
        } catch {
          return undefined
        }
      })()
      if (typeof unquoted === "string") shown = unquoted
    }
  } catch {
    // Cut: no detail.
  }
  return {
    ...input,
    run: { kind: "run", title: "Ran", detail: shown.trim().split("\n", 1)[0]!.trim() } as const,
  }
}

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
        run: gitStatus,
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
          run: gitStatus,
        }
      : {
          tool: "Bash",
          input: JSON.stringify({
            command: "git status --short",
            description: "Show what changed",
          }),
          output: " M src/checkout/total.ts",
          call,
          run: gitStatus,
        }

// The demo's conversations: each terminal running Claude Code or Codex opens with its
// `transcripts` entry, and a prompt sent to it drives the same simulated turn as one typed
// in its screen, which `turns` runs. What is sent while its agent works waits in the agent's
// queue, as the real agents keep it: the next goes once the turn ends, and Escape gives
// them all back. The requests it holds follow its agent's status, as the runner's do: an
// agent that reports `count` requests holds that many, the transcript's first and the
// rest made up, and holds none once it reports none. Answering the last one takes the
// agent on, through `turns`.
export const createDemoChat = (
  seed: WorkspaceSeed,
  transcripts: Readonly<Record<string, DemoTranscript>>,
  turns: DemoTurns,
): DemoChat => {
  let latest: Workspace | undefined
  const stores = new Map<
    string,
    {
      key: TerminalKey
      store: MutableStore<Conversation>
      // The requests made up for the agent, by id, and what answering each does.
      made: Map<string, DemoRequestOutcome>
      // What its agent last said it waits on, and whether it said anything.
      seen: Attention | undefined
      listening: boolean
      // The requests being answered now.
      answering: Set<string>
    }
  >()
  let requested = 0
  // The transcript requests each agent has asked, by terminal and the request's id in its
  // transcript: each but a plan is asked once, then the agent makes one up.
  const asked = new Set<string>()
  // The Inbox lines sent to each terminal's agent and not yet taken, one entry for each send,
  // oldest first, as the runner keeps them: they outlast an interrupt that gives the lines
  // back, and go with the agent.
  const marks = new Map<string, string[]>()
  // What each terminal's agent was sent while it worked, oldest first, and which agent it
  // was for: a later agent in the terminal never gets it.
  const queues = new Map<
    string,
    {
      readonly key: TerminalKey
      readonly agent: string
      readonly prompts: readonly Sent[]
    }
  >()
  // The terminal at the full address, in the workspace as it stands, or in the seed.
  const locate = (key: TerminalKey): Found | undefined => {
    const terminals = latest
      ? sessionOf(latest, key)?.state.roster.terminals
      : seed.projects
          .find((project) => project.id === key.projectId)
          ?.sessions.find((session) => session.id === key.workspaceSessionId)?.terminals
    const terminal = terminals?.find((each) => each.id === key.terminalId)
    return terminal ? { key, terminal } : undefined
  }
  // A terminal's own, by `projectId/slot`, else, in the first project, its slot's.
  const transcriptOf = (found: Found): DemoTranscript | undefined =>
    transcripts[`${found.key.projectId}/${terminalSlot(found.terminal.id)}`] ??
    (found.key.projectId === seed.projects[0]?.id
      ? transcripts[terminalSlot(found.terminal.id)]
      : undefined)
  // What answering a request does, where the demo can answer it.
  const outcomeOf = (
    found: Found,
    made: ReadonlyMap<string, DemoRequestOutcome>,
    id: string,
  ): DemoRequestOutcome | undefined => transcriptOf(found)?.outcomes?.[id] ?? made.get(id)
  // The requests an agent that waits on `attention` holds: those it already had of its
  // kind that can be answered or read, up to its count, and the rest made up.
  const settle = (
    found: Found,
    made: Map<string, DemoRequestOutcome>,
    had: readonly ChatRequest[],
    attention: Attention,
  ): ChatRequest[] => {
    const requests = had
      .filter(
        (request) =>
          request.kind === attention.kind &&
          !request.answered &&
          (request.dialog?.type === "raw" || outcomeOf(found, made, request.id) !== undefined),
      )
      .slice(0, attention.count)
    const transcript = transcriptOf(found)
    const askedId = (id: string): string => `${terminalKeyId(found.key)}/${id}`
    for (const request of requests)
      if (transcript?.requests.some((each) => each.id === request.id))
        asked.add(askedId(request.id))
    const name = chatAgents[chatAgent(found.terminal)!]
    while (requests.length < attention.count) {
      requested += 1
      const id = `${terminalKeyId(found.key)}:ask-${requested}`
      // A plan is the agent's own: as its transcript's plan asks, with its options. Any
      // other request its transcript holds it asks once, the first time it asks one of its
      // kind, as an agent that reached it after the transcript ends.
      const seeded = transcript?.requests?.find(
        (request) =>
          request.kind === attention.kind &&
          (request.dialog?.type === "choices" || request.dialog?.type === "questions") &&
          transcript.outcomes?.[request.id] &&
          (request.kind === "plan" || !asked.has(askedId(request.id))),
      )
      if (seeded?.dialog?.type === "choices" || seeded?.dialog?.type === "questions") {
        if (seeded.kind !== "plan") asked.add(askedId(seeded.id))
        made.set(id, transcript!.outcomes![seeded.id]!)
        requests.push({
          ...seeded,
          id,
          answered: false,
          dialog: { ...seeded.dialog, id: `${id}:d` },
        })
        continue
      }
      const request = madeRequest(attention.kind, id, name, requests.length)
      made.set(id, request.outcome)
      requests.push(request.request)
    }
    return requests
  }
  const opened = (
    found: Found | undefined,
    made: Map<string, DemoRequestOutcome>,
  ): Conversation => {
    if (!runs(found)) return noConversation
    // The sample transcripts belong to the first project's terminals, as the engine's
    // sample terminals do; another project's agents start empty, but for those a transcript
    // names by project.
    const transcript = transcriptOf(found)
    const attention = agentOf(found.terminal).attention
    made.clear()
    return {
      agent: found.terminal.process,
      session: `demo-${terminalKeyId(found.key)}`,
      loaded: true,
      items: transcript?.items ?? [],
      // An agent that reports nothing holds what its screen shows; one that does, what it
      // says it waits on.
      requests: !heard(found)
        ? (transcript?.requests ?? [])
        : attention
          ? settle(found, made, transcript?.requests ?? [], attention)
          : [],
    }
  }
  const entryOf = (key: TerminalKey) => {
    const id = terminalKeyId(key)
    const existing = stores.get(id)
    if (existing) return existing
    const found = locate(key)
    const made = new Map<string, DemoRequestOutcome>()
    const entry = {
      key,
      store: createStore(opened(found, made)),
      made,
      seen: runs(found) ? agentOf(found.terminal).attention : undefined,
      listening: heard(found),
      answering: new Set<string>(),
    }
    stores.set(id, entry)
    return entry
  }
  const storeOf = (key: TerminalKey): MutableStore<Conversation> => entryOf(key).store
  const append = (
    key: TerminalKey,
    ...drafts: (Omit<ChatItem, "id" | "at" | "truncated"> & { readonly truncated?: boolean })[]
  ) =>
    storeOf(key).update((conversation) => ({
      ...conversation,
      items: [
        ...conversation.items,
        ...drafts.map((draft, index) => ({
          ...draft,
          id: `${terminalKeyId(key)}:${conversation.items.length + index + 1}`,
          at: Date.now(),
          truncated: draft.truncated ?? false,
        })),
      ],
    }))
  // Gives the agent what was sent to it: a shell command runs at once, and a message
  // starts its turn.
  const deliver = (found: Found, sent: Sent): void => {
    const prompt = sent.text
    const command = shellCommand(prompt)
    if (command === undefined) {
      const automatic = spendMarks(marks.get(terminalKeyId(found.key)), prompt)
      turns.prompt(prompt, found.terminal, found.key, { automatic, submittedAt: sent.submittedAt })
      return
    }
    // A shell command runs without a turn. Antigravity keeps no record of it; the
    // others show the person's line and the run, as their transcripts hold them.
    if (chatAgent(found.terminal) !== "agy")
      append(
        found.key,
        { ...text("user", ""), ...bounded(`!${command}`) },
        {
          role: "tool",
          kind: "tool-call",
          ...shellCall(command),
          tool: "Bash",
          call: null,
          author: null,
          interrupted: false,
        },
        {
          role: "tool",
          kind: "tool-result",
          text: "(Bash completed with no output)",
          tool: null,
          call: null,
          author: null,
          run: null,
          interrupted: false,
        },
      )
  }
  // Whether the agent can't take a prompt now: it works, or waits on the person.
  const busy = (found: Found): boolean => {
    const agent = agentOf(found.terminal)
    return agent.working || agent.attention !== undefined || turns.working(found.key)
  }
  // Once the agent is free, it takes what waits: shell commands until a message, which
  // starts its next turn. What waited for an agent that has gone goes with it.
  const drain = (id: string): void => {
    for (let entry = queues.get(id); entry; entry = queues.get(id)) {
      const found = locate(entry.key)
      if (!runs(found) || String(found.terminal.process) !== entry.agent) {
        queues.delete(id)
        marks.delete(id)
        return
      }
      if (busy(found)) return
      const [prompt, ...rest] = entry.prompts
      if (rest.length > 0) queues.set(id, { ...entry, prompts: rest })
      else queues.delete(id)
      deliver(found, prompt!)
      if (shellCommand(prompt!.text) === undefined) return
    }
  }
  // Nothing waits on the person once a turn begins or the agent rests or is stopped.
  const clear = (key: TerminalKey): void => {
    entryOf(key).store.update((conversation) =>
      conversation.requests.length ? { ...conversation, requests: [] } : conversation,
    )
  }
  turns.watch((event: TurnEvent) => {
    const { key } = event
    if (event.type === "begin") {
      clear(key)
      if (event.prompt !== undefined) append(key, text("user", event.prompt))
    } else if (event.type === "tool") {
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
          run: run.run,
          interrupted: false,
        },
        {
          role: "tool",
          kind: "tool-result",
          text: run.output,
          tool: null,
          call: run.call,
          author: null,
          run: null,
          interrupted: false,
        },
      )
    } else if (event.type === "rest") {
      // What was sent while it worked goes with the turn.
      queues.delete(terminalKeyId(key))
      clear(key)
    } else if (event.outcome === "interrupted") {
      clear(key)
      // As every harness's chat shows the person's interruption where the turn stopped.
      append(key, { ...text("user", "Interrupted"), interrupted: true })
    } else if (event.reply) append(key, text("assistant", event.reply))
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
      refused: promptRefused,
      send: async (key, prompt, options) => {
        const found = agentFor(key)
        const name = chatAgents[chatAgent(found.terminal)!]
        const agent = agentOf(found.terminal)
        if (agent.attention)
          throw new Error(
            `${name} is waiting for your answer in its terminal. Answer it there first.`,
          )
        if (!prompt.trim()) return
        // As the runner refuses it: text the agent would read as more than a message.
        if (promptRefused(prompt, { shell: true })) throw new Error(promptRefusal)
        // The mark and the time go with the line, so a line that waits, is dropped or never
        // goes takes them along.
        const sent: Sent = { text: prompt, submittedAt: Date.now() }
        const id = terminalKeyId(found.key)
        if (options?.automatic) marks.set(id, [...(marks.get(id) ?? []), sentText(prompt)])
        // Behind a turn, or behind what already waits for one, it waits its turn.
        const waiting = queues.get(id)
        if (busy(found) || waiting) {
          queues.set(id, {
            key: found.key,
            agent: String(found.terminal.process),
            prompts: [...(waiting?.prompts ?? []), sent],
          })
          drain(id)
          return
        }
        deliver(found, sent)
      },
      interrupt: async (key) => {
        const found = agentFor(key)
        const id = terminalKeyId(found.key)
        const queued = queues.get(id)
        queues.delete(id)
        turns.interrupt(found.key, agentOf(found.terminal))
        // What waited behind the turn comes back, for the person to send again.
        return queued ? queued.prompts.map(({ text: line }) => line).join("\n") : null
      },
      answer: async (key, id, answer) => {
        const found = agentFor(key)
        const { store, made, answering } = entryOf(found.key)
        const waiting = (): ChatRequest | undefined =>
          store.getSnapshot().requests.find((request) => request.id === id && !request.answered)
        const dialog = waiting()?.dialog
        if (!waiting() || answering.has(id)) throw new Error("That request is already answered.")
        const outcome = outcomeOf(found, made, id)
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
        // Anything that takes the agent some other way meanwhile (Stop, a verb of the panel)
        // calls the answer off: it was to an agent that has moved on.
        const epoch = turns.epoch(found.key)
        const moved = (): boolean => turns.epoch(found.key) !== epoch
        answering.add(id)
        try {
          await new Promise((resolve) => setTimeout(resolve, answerMs))
          // Stopped meanwhile: the request went with the turn.
          if (moved()) throw new Error(movedOn)
          if (!waiting()) throw new Error("That request is already answered.")
          const result = outcome(answer, dialog)
          store.update((conversation) => ({
            ...conversation,
            requests: conversation.requests.map((request) =>
              request.id === id ? { ...request, answered: true } : request,
            ),
          }))
          await new Promise((resolve) => setTimeout(resolve, answeredMs))
          // The agent was stopped or taken elsewhere while the request showed as answered:
          // what that left is final, and the answer goes no further, which the caller is
          // told.
          if (moved()) {
            store.update((conversation) => ({
              ...conversation,
              requests: conversation.requests.map((request) =>
                request.id === id ? { ...request, answered: false } : request,
              ),
            }))
            throw new Error(movedOn)
          }
          // Of several requests, answering one lowers what the agent waits on and goes no
          // further; the last takes it on.
          const remaining = store.getSnapshot().requests.filter((request) => request.id !== id)
          const current = locate(found.key) ?? found
          const entry = entryOf(found.key)
          const attention = agentOf(current.terminal).attention
          entry.seen =
            attention && remaining.length ? { ...attention, count: remaining.length } : undefined
          store.update((conversation) => ({
            ...conversation,
            requests: remaining,
          }))
          append(found.key, ...result.items.map(draftOf))
          // An agent that reports nothing is never told: its screen is all that changed,
          // and what it says is in the conversation, with no turn behind it.
          if (!heard(current)) {
            if ("reply" in result) append(found.key, text("assistant", result.reply))
            return
          }
          if (!remaining.length) turns.resume(found.key, current.terminal, result)
          else turns.lower(found.key, current.terminal, remaining.length)
        } finally {
          answering.delete(id)
        }
      },
    },
    observe: (workspace) => {
      latest = workspace
      // What waited for an agent that ended goes at once, before another can start there.
      for (const [id, entry] of queues)
        if (!runs(locate(entry.key))) {
          queues.delete(id)
          marks.delete(id)
        }
      // After the commit that freed an agent has said all it says, as its turn's reply.
      if (queues.size > 0) queueMicrotask(() => [...queues.keys()].forEach(drain))
      for (const entry of stores.values()) {
        const { key, store } = entry
        const found = locate(key)
        const listening = heard(found)
        const attention = runs(found) ? agentOf(found.terminal).attention : undefined
        const changed = listening !== entry.listening || !sameAttention(attention, entry.seen)
        entry.seen = attention
        entry.listening = listening
        store.update((conversation) => {
          if (!runs(found)) return conversation.agent === null ? conversation : noConversation
          if (conversation.agent === null) return opened(found, entry.made)
          if (!changed || !listening) return conversation
          // Nothing waits once the agent has nothing to ask; what it asks now is held.
          if (!attention)
            return conversation.requests.length ? { ...conversation, requests: [] } : conversation
          return {
            ...conversation,
            requests: settle(found, entry.made, conversation.requests, attention),
          }
        })
      }
    },
    opening: (key) => {
      const found = locate(key)
      return runs(found) ? (transcriptOf(found)?.items.length ?? 0) : 0
    },
  }
}
