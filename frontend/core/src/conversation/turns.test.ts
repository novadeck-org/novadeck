import type { ChatItem, ToolOutcome } from "../conversation"
import { describe, expect, it } from "../test"
import { agentName, groupItems, recordsShell, sameBlock, turnStatus, type ToolEntry } from "./turns"

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
    const [block] = groupItems([item({ role: "agent", author: "/root/reviewer", text: "done" })])
    expect(block).toMatchObject({ kind: "agent", author: "/root/reviewer", text: "done" })
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
