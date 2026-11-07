import type { ChatItem, ChatPrompt, ToolChange, ToolOutcome, ToolRun } from "../conversation"
import { harnesses } from "../harnesses"
import type { AgentMessage } from "../messages"
import type { AgentStatus } from "../types"
import { counted } from "../units"

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
  // What came of it, once it has a result; null where its harness doesn't say.
  readonly outcome: ToolOutcome | null
  // Whether the harness made it inside a script of the agent's. Nothing names the script: it
  // came before, and one that outlived its script may land after other entries.
  readonly scripted: boolean
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
  // A turn Novadeck's doorbell started, where a prompt of the person's would stand: the messages
  // it brought (`messagesOfRing`), null where those aren't known, and `replies` where it carries
  // the person's own Inbox replies.
  | {
      readonly kind: "doorbell"
      readonly id: string
      readonly at: number | null
      readonly messages: readonly AgentMessage[] | null
      readonly replies: boolean
    }
  // A compaction: the summary the agent goes on from.
  | {
      readonly kind: "compaction"
      readonly id: string
      readonly at: number | null
      readonly summary: string
      readonly truncated: boolean
    }
  // A part of the record the backend can't read, where it stands: the line as written, empty
  // where it can't be shown.
  | {
      readonly kind: "gap"
      readonly id: string
      readonly raw: string
      readonly truncated: boolean
    }
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

// What a harness's own tools do: only they have it write the words a result opens with, or
// a command's code. Any other tool's output may print the same.
const ownTool = (run: ToolRun | null): boolean =>
  run?.kind === "run" || run?.kind === "read" || run?.kind === "write"

// One outcome of what a call's input said and what its result says, which outranks it. The
// input's change is only a plan until the result says it went well; a change that failed never
// landed. A result may count a change whose lines only the input has.
const outcomeOf = (
  run: ToolRun | null,
  planned: ToolChange | null,
  result: ChatItem,
): ToolOutcome | null => {
  const own = ownTool(run)
  const said = result.outcome?.opening && !own ? null : result.outcome
  const failed = said?.failed ?? null
  const landed = failed === false ? planned : null
  const told = failed === true ? null : (said?.change ?? null)
  const counts = told ?? landed
  if (!said && !counts) return null
  return {
    failed,
    exit: own ? (said?.exit ?? null) : null,
    running: said?.running ?? false,
    size: said?.size ?? null,
    change: counts && { ...counts, lines: told?.lines.length ? told.lines : (landed?.lines ?? []) },
    opening: said?.opening ?? false,
  }
}

// The items without those of the prompts a Stop handed back: the record wrote them, but they
// never went, and their words are the person's again.
export const wentItems = (
  items: readonly ChatItem[],
  prompts: readonly ChatPrompt[],
): readonly ChatItem[] => {
  const back = new Set(
    prompts.filter((prompt) => prompt.state === "withdrawn").map((prompt) => prompt.item),
  )
  return back.size === 0 ? items : items.filter((_, at) => !back.has(at))
}

// How long before a ring's record a message it brought may be delivered, in milliseconds: its
// prompt's hook runs as the record is written, and records keep whole seconds at the coarsest.
const ringSlackMs = 2_000

// The messages delivered from the ring at `at`, in `items`, up to the next prompt of anyone's: a
// message taken at a tool call of that turn came in it, and each comes with one ring only. Null
// where none can be told, which says nothing of how many there were: `delivered` holds only
// what the backend still lists, and a harness may not date its record.
const messagesOfRing = (
  items: readonly ChatItem[],
  index: number,
  delivered: readonly AgentMessage[],
): readonly AgentMessage[] | null => {
  const { at } = items[index]!
  if (at === null) return null
  const next = items
    .slice(index + 1)
    .find((item) => item.role === "user" && item.kind === "text" && !item.interrupted)
  const until = next?.at === null || next === undefined ? Infinity : next.at - ringSlackMs
  const brought = delivered.filter(
    ({ deliveredAt }) =>
      deliveredAt !== null && deliveredAt >= at - ringSlackMs && deliveredAt < until,
  )
  return brought.length > 0 ? brought : null
}

// The items grouped in order. A result is paired by `call` with its call wherever it is
// (it may come first); one with no `call` goes to the latest call still waiting. A result
// whose call is not among the items stands alone.
// What a mode says as a line of the chat, by the harness's word for it. A word this doesn't know
// shows as it is: a harness's new mode is still a change the person should see.
const modeWords: Readonly<Record<string, string>> = {
  default: "default mode",
  "not-plan": "plan mode off",
  plan: "plan mode",
  acceptEdits: "auto-accept edits",
  bypassPermissions: "skipping permissions",
  dontAsk: "not asking",
  auto: "auto mode",
  never: "never asks",
  "on-failure": "asks on failure",
  untrusted: "asks for untrusted commands",
}

export const groupItems = (
  items: readonly ChatItem[],
  delivered: readonly AgentMessage[] = [],
): readonly ChatBlock[] => {
  const calls = new Set<string>()
  const results = new Map<string, ChatItem>()
  for (const item of items) {
    if (item.kind === "tool-call" && item.call) calls.add(item.call)
    if (item.kind === "tool-result" && item.call && !results.has(item.call))
      results.set(item.call, item)
  }
  const blocks: ChatBlock[] = []
  let mode: string | undefined
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
        outcome: result ? outcomeOf(item.run, item.outcome?.change ?? null, result) : null,
        scripted: item.scripted,
      })
      continue
    }
    if (item.kind === "tool-result") {
      // Paired with a call among the items: shown with it.
      if (item.call && calls.has(item.call)) continue
      const last = open.run?.at(-1)
      if (!item.call && open.run && last && !last.result && !last.call) {
        open.run[open.run.length - 1] = {
          ...last,
          result: asResult(item),
          outcome: outcomeOf(last.run, null, item),
        }
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
        outcome: outcomeOf(null, null, item),
        scripted: item.scripted,
      })
      continue
    }
    open.run = null
    if (item.note) {
      const { note } = item
      if (note.type === "compaction")
        blocks.push({
          kind: "compaction",
          id: item.id,
          at: item.at,
          summary: item.text,
          truncated: item.truncated,
        })
      else if (note.type === "gap")
        blocks.push({ kind: "gap", id: item.id, raw: item.text, truncated: item.truncated })
      else if (note.type === "plan-approved")
        blocks.push({ kind: "note", id: item.id, text: "plan approved" })
      else {
        // A harness says its mode again and again: only a change is news, and the first says
        // what it was, which is no change.
        if (mode !== undefined && mode !== note.mode)
          blocks.push({ kind: "note", id: item.id, text: modeWords[note.mode] ?? note.mode })
        mode = note.mode
      }
      continue
    }
    if (item.role === "user") {
      blocks.push(
        item.interrupted
          ? { kind: "note", id: item.id, text: "Interrupted" }
          : item.ring
            ? {
                kind: "doorbell",
                id: item.id,
                at: item.at,
                messages: messagesOfRing(items, items.indexOf(item), delivered),
                replies: item.ring.replies,
              }
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

// An outcome is small, and the same record gives the same one, so its text tells them apart.
const sameOutcome = (a: ToolOutcome | null, b: ToolOutcome | null): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b)

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
  a.result?.truncated === b.result?.truncated &&
  a.scripted === b.scripted &&
  sameOutcome(a.outcome, b.outcome)

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
  if (a.kind === "compaction" || b.kind === "compaction")
    return a.kind === "compaction" && b.kind === "compaction" && a.id === b.id
  if (a.kind === "gap" || b.kind === "gap")
    return a.kind === "gap" && b.kind === "gap" && a.id === b.id
  if (a.kind === "doorbell" || b.kind === "doorbell")
    return (
      a.kind === "doorbell" &&
      b.kind === "doorbell" &&
      a.id === b.id &&
      a.replies === b.replies &&
      a.messages?.length === b.messages?.length
    )
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.text === b.text &&
    a.truncated === b.truncated &&
    (a.kind !== "agent" || (b.kind === "agent" && a.author === b.author))
  )
}

// ---- What the agent is doing, in a line.

export type TurnStatus = {
  // The agent works: the chat shows its indicator.
  readonly working: boolean
  readonly text: string
}

// What the chat says of the agent's turn: working (planning, with the subagents or
// background work it started running), or, once it rests, how its last turn ended where
// that wasn't a plain finish. Null when there is nothing to add.
export const turnStatus = (agent: AgentStatus | undefined): TurnStatus | null => {
  if (!agent) return null
  if (agent.working) {
    const parts = [agent.planning ? "Planning" : "Working"]
    // As the tab's marks count them (`subagentMarks`): the larger of the listed and the
    // background count.
    const subagents = Math.max(agent.subagents?.length ?? 0, agent.background?.agents ?? 0)
    if (subagents > 0) parts.push(`${counted(subagents, "subagent")} running`)
    const tasks = agent.background?.tasks ?? 0
    if (tasks > 0) parts.push(counted(tasks, "background task"))
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
