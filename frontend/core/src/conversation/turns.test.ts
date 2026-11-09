import type { ChatItem, ChatPrompt, ToolOutcome } from "../conversation"
import type { AgentMessage } from "../messages"
import { describe, expect, it } from "../test"
import {
  agentName,
  groupItems,
  recordsShell,
  sameBlock,
  turnStatus,
  wentItems,
  type ToolEntry,
} from "./turns"

let count = 0
const item = (fields: Partial<ChatItem>): ChatItem => ({
  id: `i${++count}`,
  at: null,
  role: "assistant",
  kind: "text",
  text: "",
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  outcome: null,
  scripted: false,
  interrupted: false,
  ring: null,
  ...fields,
})
const call = (tool: string, id: string | null, text = "{}") =>
  item({
    kind: "tool-call",
    tool,
    call: id,
    text,
    run: { kind: "other", title: tool, detail: "" },
  })
const result = (id: string | null, text = "ok") =>
  item({ role: "tool", kind: "tool-result", call: id, text })

const told = (fields: Partial<ToolOutcome>): ToolOutcome => ({
  failed: null,
  exit: null,
  running: false,
  size: null,
  change: null,
  opening: false,
  ...fields,
})

const entriesOf = (items: readonly ChatItem[]): readonly ToolEntry[] =>
  groupItems(items).flatMap((block) => (block.kind === "tools" ? block.entries : []))

describe("a tool call's outcome", () => {
  const change = {
    added: 2,
    removed: 1,
    lines: [{ sign: "+", text: "a", line: null }],
  } as const
  const edit = (id: string) => ({ ...call("Edit", id), outcome: told({ change }) })

  const bash = (id: string) => ({
    ...call("Bash", id),
    run: { kind: "run", title: "Ran", detail: "" } as const,
  })

  it("comes from its result", () => {
    const [entry] = entriesOf([
      bash("a"),
      { ...result("a"), outcome: told({ failed: true, exit: 3 }) },
    ])
    expect(entry!.outcome).toEqual(told({ failed: true, exit: 3 }))
  })

  it("is null where its harness says nothing, so the chat keeps its line", () => {
    expect(entriesOf([call("Bash", "a"), result("a")])[0]!.outcome).toBeNull()
  })

  it("joins what its input said to what its result says", () => {
    const [entry] = entriesOf([edit("a"), { ...result("a"), outcome: told({ failed: false }) }])
    expect(entry!.outcome).toEqual(told({ failed: false, change }))
  })

  it("reads the same when its result comes first", () => {
    const [entry] = entriesOf([{ ...result("a"), outcome: told({ failed: false }) }, edit("a")])
    expect(entry!.outcome).toEqual(told({ failed: false, change }))
  })

  it("holds an input's change as a plan until the result says it went well", () => {
    expect(entriesOf([edit("a"), result("a", "patch rejected")])[0]!.outcome).toBeNull()
    expect(
      entriesOf([edit("a"), { ...result("a"), outcome: told({ running: true }) }])[0]!.outcome,
    ).toEqual(told({ running: true }))
  })

  it("is nothing yet while the call runs: its input's change is no result", () => {
    expect(entriesOf([edit("a")])[0]!.outcome).toBeNull()
  })

  it("drops a change that failed, as it never landed", () => {
    const [entry] = entriesOf([edit("a"), { ...result("a"), outcome: told({ failed: true }) }])
    expect(entry!.outcome).toEqual(told({ failed: true }))
  })

  it("takes a result's counts over its input's, keeping the lines only the input has", () => {
    const counted = told({ failed: false, change: { added: 5, removed: 4, lines: [] } })
    const [entry] = entriesOf([edit("a"), { ...result("a"), outcome: counted }])
    expect(entry!.outcome?.change).toEqual({ added: 5, removed: 4, lines: change.lines })
  })

  it("takes a result's own lines over its input's", () => {
    const lines = [{ sign: "-", text: "b", line: 7 }] as const
    const counted = told({ change: { added: 0, removed: 1, lines } })
    const [entry] = entriesOf([edit("a"), { ...result("a"), outcome: counted }])
    expect(entry!.outcome?.change).toEqual({ added: 0, removed: 1, lines })
  })

  it("stays on a result whose call isn't among the items", () => {
    const outcome = told({ failed: true })
    expect(entriesOf([{ ...result("a"), outcome }])[0]!.outcome).toEqual(outcome)
  })

  it("drops a failed change there too", () => {
    const outcome = told({ failed: true, change })
    expect(entriesOf([{ ...result("a"), outcome }])[0]!.outcome).toEqual(told({ failed: true }))
  })

  describe("from the words a result opens with", () => {
    const worded = told({ failed: true, exit: 3, opening: true })
    const of = (kind: "run" | "other") =>
      entriesOf([
        { ...call("Tool", "a"), run: { kind, title: "Tool", detail: "" } },
        { ...result("a"), outcome: worded },
      ])[0]!.outcome

    it("holds for a tool of the harness's own", () => {
      expect(of("run")).toEqual(worded)
    })

    it("is another tool's printing, so nothing", () => {
      expect(of("other")).toBeNull()
    })

    it("is nothing where its call isn't among the items", () => {
      expect(entriesOf([{ ...result("a"), outcome: worded }])[0]!.outcome).toBeNull()
    })
  })

  it("keeps a mark on any tool, but a code only on a command's", () => {
    const outcome = told({ failed: true, exit: 5 })
    const [entry] = entriesOf([call("mcp", "a"), { ...result("a"), outcome }])
    expect(entry!.outcome).toEqual(told({ failed: true }))
  })

  it("stays on a result paired by being the latest", () => {
    const outcome = told({ failed: false })
    const [entry] = entriesOf([call("Bash", null), { ...result(null), outcome }])
    expect(entry!.outcome).toEqual(outcome)
  })

  it("makes another block of another outcome, so the chat draws it", () => {
    const blockOf = (outcome: ToolOutcome) =>
      groupItems([
        { ...bash("a"), id: "c" },
        { ...result("a"), id: "r", outcome },
      ])[0]!
    expect(sameBlock(blockOf(told({ exit: 0 })), blockOf(told({ exit: 0 })))).toBe(true)
    expect(sameBlock(blockOf(told({ exit: 0 })), blockOf(told({ exit: 1 })))).toBe(false)
  })

  it("marks a call made inside a script, in record order after the script's", () => {
    const entries = entriesOf([
      call("exec", "s"),
      { ...call("exec_command", "e"), scripted: true },
      { ...result("e"), scripted: true },
      result("s"),
    ])
    expect(entries.map(({ tool, scripted }) => [tool, scripted])).toEqual([
      ["exec", false],
      ["exec_command", true],
    ])
  })
})

describe("grouping a conversation's items", () => {
  it("keeps the person's and the agent's text as they come", () => {
    const blocks = groupItems([
      item({ role: "user", text: "hi" }),
      item({ role: "assistant", text: "hello" }),
    ])
    expect(blocks.map((block) => block.kind)).toEqual(["user", "assistant"])
  })

  it("shows another agent's message with its author", () => {
    const [block] = groupItems([item({ role: "agent", author: "reviewer", text: "done" })])
    expect(block).toMatchObject({ kind: "agent", author: "reviewer", text: "done" })
  })

  it("pairs a result with its call and folds consecutive calls into one run", () => {
    const blocks = groupItems([
      call("Read", "a"),
      result("a", "file text"),
      call("Bash", "b"),
      result("b", "out"),
    ])
    expect(blocks).toHaveLength(1)
    const [run] = blocks
    expect(run).toMatchObject({ kind: "tools" })
    expect(run!.kind === "tools" && run!.entries.map((e) => [e.tool, e.result?.text])).toEqual([
      ["Read", "file text"],
      ["Bash", "out"],
    ])
  })

  it("pairs a result that comes before its call", () => {
    const [run] = groupItems([result("a", "early"), call("Read", "a")])
    expect(run).toMatchObject({ kind: "tools" })
    const entries = run!.kind === "tools" ? run!.entries : []
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ tool: "Read", result: { text: "early" } })
  })

  it("leaves a call without a result waiting", () => {
    const [run] = groupItems([call("Bash", "a")])
    expect(run!.kind === "tools" && run!.entries[0]!.result).toBeNull()
  })

  it("starts a new run after text", () => {
    const blocks = groupItems([call("Read", "a"), item({ text: "reading" }), call("Read", "b")])
    expect(blocks.map((block) => block.kind)).toEqual(["tools", "assistant", "tools"])
  })

  it("gives a result with no call to the latest call that has none either", () => {
    const [run] = groupItems([call("shell", null), result(null, "done")])
    expect(run!.kind === "tools" && run!.entries).toHaveLength(1)
    expect(run!.kind === "tools" && run!.entries[0]!.result?.text).toBe("done")
  })

  it("shows a result whose call is not there on its own", () => {
    const [run] = groupItems([result("gone", "late")])
    expect(run!.kind === "tools" && run!.entries[0]).toMatchObject({
      tool: null,
      result: { text: "late" },
    })
  })

  it("turns an interrupted user item into a note", () => {
    const [block] = groupItems([
      item({ role: "user", text: "[Request interrupted by user for tool use]", interrupted: true }),
    ])
    expect(block).toMatchObject({ kind: "note", text: "Interrupted" })
  })

  it("leaves the words of an item the harness didn't mark as interrupted alone", () => {
    const [block] = groupItems([item({ role: "user", text: "[Request interrupted by user]" })])
    expect(block).toMatchObject({ kind: "user" })
  })

  it('carries what a call was, and names a call with no tool "tool"', () => {
    const run = { kind: "run", title: "Ran", detail: "ls" } as const
    const [block] = groupItems([
      item({ kind: "tool-call", tool: "Bash", call: "a", text: "{}", run }),
      item({ kind: "tool-call", tool: null, call: "b", text: "{}", run: null }),
    ])
    const entries = block!.kind === "tools" ? block!.entries : []
    expect(entries.map((entry) => [entry.tool, entry.run])).toEqual([
      ["Bash", run],
      ["tool", null],
    ])
  })
})

describe("a subagent's report", () => {
  const sub = (id: string | null, detail: string, tool = "Task") =>
    item({
      kind: "tool-call",
      tool,
      call: id,
      run: { kind: "agent", title: "Subagent", detail, subagent: true },
    })
  const kinds = (items: readonly ChatItem[]) => groupItems(items).map((block) => block.kind)

  it("is a Codex message from a path of the agent tree, named by its last segment", () => {
    const [block] = groupItems([
      item({ role: "agent", author: "/root/explorer_1", text: "found it", at: 5 }),
    ])
    expect(block).toMatchObject({
      kind: "subagent",
      name: "explorer 1",
      text: "found it",
      running: false,
      failed: false,
      at: 5,
    })
  })

  it("is not the person's or a peer's: the parent speaking to a subagent is named so", () => {
    expect(groupItems([item({ role: "agent", author: "/root", text: "go" })])[0]).toMatchObject({
      kind: "subagent",
      name: "parent agent",
    })
    expect(groupItems([item({ role: "agent", author: null, text: "hi" })])[0]).toMatchObject({
      kind: "agent",
      author: "Another agent",
    })
  })

  it("comes out of a run of commands, which go on either side of it in order", () => {
    const blocks = groupItems([
      call("Bash", "a"),
      result("a"),
      sub("t", "Survey the repo"),
      result("t", "the report"),
      call("Bash", "b"),
      result("b"),
    ])
    expect(blocks.map((block) => block.kind)).toEqual(["tools", "subagent", "tools"])
    expect(blocks[1]).toMatchObject({
      name: "Survey the repo",
      text: "the report",
      running: false,
      call: "t",
    })
    expect(blocks[0]).toMatchObject({ entries: [{ call: "a" }] })
    expect(blocks[2]).toMatchObject({ entries: [{ call: "b" }] })
  })

  it("keeps consecutive subagents as blocks of their own, and works for Antigravity's tool", () => {
    expect(
      kinds([sub("x", "one", "invoke_subagent"), sub("y", "two", "invoke_subagent"), result("y")]),
    ).toEqual(["subagent", "subagent"])
  })

  it("is running, with no report, until its result comes", () => {
    expect(groupItems([sub("t", "")])[0]).toMatchObject({
      name: "subagent",
      text: null,
      running: true,
    })
  })

  it("keeps running past a background launch note, and takes the later notice as its report", () => {
    const launch = item({
      role: "tool",
      kind: "tool-result",
      call: "t",
      text: "Async agent launched",
      outcome: told({ running: true }),
    })
    const report = item({
      role: "tool",
      kind: "tool-result",
      call: "t",
      text: "the report",
      outcome: told({ failed: false }),
    })
    expect(groupItems([sub("t", "x"), launch])[0]).toMatchObject({ text: null, running: true })
    expect(groupItems([sub("t", "x"), launch, call("Bash", "b"), report])).toMatchObject([
      { kind: "subagent", text: "the report", running: false },
      { kind: "tools" },
    ])
  })

  it("says it failed when its result does", () => {
    const failed = item({
      role: "tool",
      kind: "tool-result",
      call: "t",
      text: "boom",
      outcome: told({ failed: true }),
    })
    expect(groupItems([sub("t", "x"), failed])[0]).toMatchObject({ failed: true, text: "boom" })
  })

  it("is only a call that starts one: messaging or spawning one stays a command", () => {
    const messaged = item({
      kind: "tool-call",
      tool: "SendMessage",
      call: "m",
      run: { kind: "agent", title: "Messaged @fox", detail: "hi" },
    })
    const spawned = item({
      kind: "tool-call",
      tool: "spawn_agent",
      call: "s",
      run: { kind: "agent", title: "Subagent", detail: "lint" },
    })
    expect(kinds([messaged, spawned])).toEqual(["tools"])
  })

  it("leaves a peer's doorbell message a doorbell", () => {
    const ring = item({ role: "user", text: "[line]", ring: { nonce: "n7Q2", replies: false } })
    expect(kinds([ring])).toEqual(["doorbell"])
  })

  it("is told apart by what it says", () => {
    const one = groupItems([sub("t", "x")])[0]!
    const two = groupItems([sub("t", "x"), result("t", "done")])[0]!
    expect(sameBlock(one, one)).toBe(true)
    expect(sameBlock(one, two)).toBe(false)
  })
})

describe("telling blocks apart", () => {
  it("finds the blocks of two groupings of the same items the same", () => {
    const items = [item({ role: "user", text: "hi" }), call("Read", "a"), result("a", "x")]
    const [first, second] = [groupItems(items), groupItems(items)]
    expect(first.every((block, index) => sameBlock(block, second[index]!))).toBe(true)
  })

  it("finds a run that gained its result different", () => {
    const calls = [call("Bash", "b")]
    const before = groupItems(calls)[0]!
    const after = groupItems([...calls, result("b", "done")])[0]!
    expect(sameBlock(before, after)).toBe(false)
  })
})

const end = (outcome: "completed" | "failed" | "interrupted" | "unknown") =>
  turnStatus({ working: false, lastTurn: { outcome, at: 1 } })

describe("the agent's turn status", () => {
  it("says it works, planning, and with the subagents it runs", () => {
    expect(turnStatus({ working: true })).toEqual({ working: true, text: "Working" })
    expect(turnStatus({ working: true, planning: true })?.text).toBe("Planning")
    expect(
      turnStatus({
        working: true,
        subagents: [
          { id: "a", type: null },
          { id: "b", type: null },
        ],
      })?.text,
    ).toBe("Working · 2 subagents running")
  })

  it("counts the subagents as the tab's marks do: the larger of the listed and the background", () => {
    const working = (listed: number, background: number) =>
      turnStatus({
        working: true,
        subagents: Array.from({ length: listed }, (_, index) => ({ id: `${index}`, type: null })),
        background: { agents: background, tasks: 0 },
      })?.text
    expect(working(0, 3)).toBe("Working · 3 subagents running")
    expect(working(1, 3)).toBe("Working · 3 subagents running")
    expect(working(2, 1)).toBe("Working · 2 subagents running")
  })

  it("says how an ended turn stopped, when it didn't just finish", () => {
    expect(end("interrupted")?.text).toBe("Stopped before it finished")
    expect(end("failed")?.text).toBe("Stopped with an error")
    expect(end("completed")).toBeNull()
    expect(turnStatus(undefined)).toBeNull()
  })

  it("names the harness' agents", () => {
    expect([agentName("claude"), agentName("codex"), agentName("agy"), agentName(null)]).toEqual([
      "Claude",
      "Codex",
      "Antigravity",
      "The agent",
    ])
  })

  it("says which agents record a shell command sent to them", () => {
    expect([
      recordsShell("claude"),
      recordsShell("codex"),
      recordsShell("agy"),
      recordsShell(null),
    ]).toEqual([true, true, false, true])
    expect(recordsShell("unknown")).toBe(true)
  })
})

describe("the items of a conversation that went", () => {
  const items = [{ text: "one" }, { text: "two" }, { text: "three" }] as unknown as ChatItem[]
  const prompt = (state: ChatPrompt["state"], at: number | null): ChatPrompt => ({
    ref: "r",
    text: null,
    sentAt: 1,
    state,
    item: at,
  })

  it("leaves out those of prompts a Stop handed back, and only those", () => {
    expect(wentItems(items, [prompt("withdrawn", 1), prompt("settled", 2)])).toEqual([
      items[0],
      items[2],
    ])
  })

  it("is the items as they are where no item was handed back", () => {
    expect(wentItems(items, [])).toBe(items)
    expect(wentItems(items, [prompt("settled", 1)])).toEqual(items)
    expect(wentItems(items, [prompt("withdrawn", null)])).toEqual(items)
  })
})

describe("a turn the doorbell started", () => {
  const ring = (at: number | null, replies = false) =>
    item({ role: "user", kind: "text", text: "[line]", at, ring: { nonce: "n7Q2", replies } })
  const prompt = (at: number | null) => item({ role: "user", kind: "text", text: "mine", at })
  const reply = (at: number) => item({ role: "assistant", kind: "text", text: "said", at })
  const message = (deliveredAt: number | null) =>
    ({ id: `m-${deliveredAt}`, deliveredAt }) as unknown as AgentMessage
  const brought = (items: readonly ChatItem[], delivered: readonly AgentMessage[]) =>
    groupItems(items, delivered).flatMap((block) =>
      block.kind === "doorbell"
        ? [block.messages?.map(({ deliveredAt }) => deliveredAt) ?? null]
        : [],
    )

  it("stands as a doorbell, not the person's words", () => {
    const [block] = groupItems([ring(10_000)])
    expect(block).toMatchObject({ kind: "doorbell", messages: null, replies: false })
    expect(block).not.toHaveProperty("text")
  })

  it("says it carries the person's replies", () => {
    expect(groupItems([ring(10_000, true)])[0]).toMatchObject({ replies: true })
  })

  it("brings what was delivered from just before it up to the next prompt", () => {
    const items = [ring(10_000), reply(11_000), prompt(30_000)]
    expect(brought(items, [message(8_500), message(20_000)])).toEqual([[8_500, 20_000]])
  })

  it("leaves what came long before it, and what came with the next prompt", () => {
    const items = [ring(10_000), prompt(30_000)]
    expect(brought(items, [message(7_000), message(29_000), message(40_000)])).toEqual([null])
  })

  it("goes on to the end where no prompt follows, as the latest ring does", () => {
    expect(brought([ring(10_000), reply(11_000)], [message(90_000)])).toEqual([[90_000]])
  })

  it("gives a message to one ring only, the rings close together", () => {
    const items = [ring(10_000), ring(12_000)]
    expect(brought(items, [message(9_000), message(11_000)])).toEqual([[9_000], [11_000]])
  })

  it("knows nothing of a record with no date, rather than bringing nothing", () => {
    expect(brought([ring(null)], [message(10_000)])).toEqual([null])
  })

  it("is drawn again once what it brought is known", () => {
    const rung = ring(10_000)
    const before = groupItems([rung])[0]!
    expect(sameBlock(before, groupItems([rung], [message(10_000)])[0]!)).toBe(false)
    expect(sameBlock(before, groupItems([rung])[0]!)).toBe(true)
  })
})

describe("what a harness says between turns", () => {
  const mode = (word: string) => item({ role: "note", note: { type: "mode", mode: word } })
  const notes = (items: readonly ChatItem[]) =>
    groupItems(items).flatMap((block) => (block.kind === "note" ? [block.text] : []))

  it("is a line where the mode changed, not each time it's said", () => {
    expect(
      notes([mode("default"), mode("default"), mode("acceptEdits"), mode("acceptEdits")]),
    ).toEqual(["auto-accept edits"])
  })

  it("says nothing of the mode it starts in", () => {
    expect(notes([mode("plan")])).toEqual([])
  })

  it("shows a mode it doesn't know as it's named, as a change still", () => {
    expect(notes([mode("default"), mode("brandNewMode")])).toEqual(["brandNewMode"])
  })

  it("says a plan went through", () => {
    expect(notes([item({ role: "note", note: { type: "plan-approved" } })])).toEqual([
      "plan approved",
    ])
  })

  it("gives a compaction its summary", () => {
    const [block] = groupItems([
      item({ role: "note", text: "So far", note: { type: "compaction" } }),
    ])
    expect(block).toMatchObject({ kind: "compaction", summary: "So far" })
  })

  it("gives a gap the line as written, where it stands", () => {
    const blocks = groupItems([
      item({ role: "user", text: "mine" }),
      item({ role: "note", text: "{}", note: { type: "gap" } }),
      item({ role: "assistant", text: "said" }),
    ])
    expect(blocks.map(({ kind }) => kind)).toEqual(["user", "gap", "assistant"])
    expect(blocks[1]).toMatchObject({ raw: "{}" })
  })

  it("adds no message to what's around it", () => {
    const blocks = groupItems([
      item({ role: "user", text: "mine" }),
      mode("default"),
      item({ role: "assistant", text: "said" }),
    ])
    expect(blocks.map(({ kind }) => kind)).toEqual(["user", "assistant"])
  })
})
