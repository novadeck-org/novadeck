import type { ChatItem, ToolRun } from "./conversation"
import { harnesses } from "./harnesses"
import type { AgentStatus } from "./types"

// A conversation's items as a chat shows them: the person's messages, the agent's text,
// other agents' messages, and runs of tool calls, each call with the result its harness
// paired with it. Pure: the chat view renders what this returns.

// What a tool call came back with; null while it runs.
export type ToolResult = {
  readonly id: string
  readonly text: string
  readonly truncated: boolean
}

// One tool call. `tool` and `run` are null for a result whose call isn't among the items (a
// call left out of the window the backend carries), which still shows, as "Result".
export type ToolEntry = {
  readonly id: string
  readonly call: string | null
  readonly tool: string | null
  readonly run: ToolRun | null
  readonly input: string
  readonly truncated: boolean
  readonly result: ToolResult | null
}

export type ChatBlock =
  | {
      readonly kind: "user" | "assistant"
      readonly id: string
      readonly text: string
      readonly truncated: boolean
      readonly at: number | null
    }
  | {
      // Another agent's message, `author` in its harness's words.
      readonly kind: "agent"
      readonly id: string
      readonly author: string
      readonly text: string
      readonly truncated: boolean
      readonly at: number | null
    }
  // What the harness records of the person stopping the agent, and the like: a line, not a
  // message.
  | { readonly kind: "note"; readonly id: string; readonly text: string }
  // Consecutive tool calls, which the chat folds into one run.
  | {
      readonly kind: "tools"
      readonly id: string
      readonly entries: readonly ToolEntry[]
    }

const asResult = (item: ChatItem): ToolResult => ({
  id: item.id,
  text: item.text,
  truncated: item.truncated,
})

// The items grouped in order. A result is paired by `call` with its call wherever it is
// (it may come first); one with no `call` goes to the latest call still waiting. A result
// whose call is not among the items stands alone.
export const groupItems = (items: readonly ChatItem[]): readonly ChatBlock[] => {
  const calls = new Set<string>()
  const results = new Map<string, ChatItem>()
  for (const item of items) {
    if (item.kind === "tool-call" && item.call) calls.add(item.call)
    if (item.kind === "tool-result" && item.call && !results.has(item.call))
      results.set(item.call, item)
  }
  const blocks: ChatBlock[] = []
  // The run of tool calls the latest items continue, if they do.
  const open: { run: ToolEntry[] | null } = { run: null }
  const entryBlock = (entry: ToolEntry): void => {
    if (open.run) open.run.push(entry)
    else {
      open.run = [entry]
      blocks.push({ kind: "tools", id: entry.id, entries: open.run })
    }
  }
  for (const item of items) {
    if (item.kind === "tool-call") {
      const result = item.call ? results.get(item.call) : undefined
      entryBlock({
        id: item.id,
        call: item.call,
        tool: item.tool ?? "tool",
        run: item.run,
        input: item.text,
        truncated: item.truncated,
        result: result ? asResult(result) : null,
      })
      continue
    }
    if (item.kind === "tool-result") {
      // Paired with a call among the items: shown with it.
      if (item.call && calls.has(item.call)) continue
      const last = open.run?.at(-1)
      if (!item.call && open.run && last && !last.result && !last.call) {
        open.run[open.run.length - 1] = { ...last, result: asResult(item) }
        continue
      }
      entryBlock({
        id: item.id,
        call: item.call,
        tool: null,
        run: null,
        input: "",
        truncated: false,
        result: asResult(item),
      })
      continue
    }
    open.run = null
    if (item.role === "user") {
      blocks.push(
        item.interrupted
          ? { kind: "note", id: item.id, text: "Interrupted" }
          : {
              kind: "user",
              id: item.id,
              text: item.text,
              truncated: item.truncated,
              at: item.at,
            },
      )
    } else if (item.role === "agent")
      blocks.push({
        kind: "agent",
        id: item.id,
        author: item.author ?? "Another agent",
        text: item.text,
        truncated: item.truncated,
        at: item.at,
      })
    else
      blocks.push({
        kind: "assistant",
        id: item.id,
        text: item.text,
        truncated: item.truncated,
        at: item.at,
      })
  }
  return blocks
}

const sameEntry = (a: ToolEntry, b: ToolEntry): boolean =>
  a.id === b.id &&
  a.tool === b.tool &&
  a.run?.kind === b.run?.kind &&
  a.run?.title === b.run?.title &&
  a.run?.detail === b.run?.detail &&
  a.input === b.input &&
  a.truncated === b.truncated &&
  a.result?.id === b.result?.id &&
  a.result?.text === b.result?.text &&
  a.result?.truncated === b.result?.truncated

// Whether two groupings made the same block, so a view can keep what it drew: grouping
// builds new objects each time, though the items under most of them are the same.
export const sameBlock = (a: ChatBlock, b: ChatBlock): boolean => {
  if (a === b) return true
  if (a.kind === "tools" || b.kind === "tools")
    return (
      a.kind === "tools" &&
      b.kind === "tools" &&
      a.id === b.id &&
      a.entries.length === b.entries.length &&
      a.entries.every((entry, index) => sameEntry(entry, b.entries[index]!))
    )
  if (a.kind === "note" || b.kind === "note")
    return a.kind === "note" && b.kind === "note" && a.id === b.id && a.text === b.text
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.text === b.text &&
    a.truncated === b.truncated &&
    (a.kind === "agent" ? a.author === (b as typeof a).author : true)
  )
}

// ---- What the agent is doing, in a line.

export type TurnStatus = {
  // The agent works: the chat shows its indicator.
  readonly working: boolean
  readonly text: string
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`

// What the chat says of the agent's turn: working (planning, with the subagents or
// background work it started running), or, once it rests, how its last turn ended where
// that wasn't a plain finish. Null when there is nothing to add.
export const turnStatus = (agent: AgentStatus | undefined): TurnStatus | null => {
  if (!agent) return null
  if (agent.working) {
    const parts = [agent.planning ? "Planning" : "Working"]
    const subagents = agent.subagents?.length ?? agent.background?.agents ?? 0
    if (subagents > 0) parts.push(`${plural(subagents, "subagent")} running`)
    const tasks = agent.background?.tasks ?? 0
    if (tasks > 0) parts.push(`${plural(tasks, "background task")}`)
    return { working: true, text: parts.join(" · ") }
  }
  switch (agent.lastTurn?.outcome) {
    case "interrupted":
      return { working: false, text: "Stopped before it finished" }
    case "failed":
      return { working: false, text: "Stopped with an error" }
    default:
      return null
  }
}

// An agent as its harness names it, as a person does.
export const agentName = (agent: string | null): string =>
  harnesses.find(({ id }) => id === agent)?.shortName ?? "The agent"

// Whether the agent's conversation records a shell command the person sends it, with its
// output. An agent no harness names is taken to, so the chat says nothing of it.
export const recordsShell = (agent: string | null): boolean =>
  harnesses.find(({ id }) => id === agent)?.recordsShell ?? true
