import type { ChatItem } from "../conversation"
import { describe, expect, it } from "../test"
import { agentName, groupItems, recordsShell, sameBlock, turnStatus } from "./turns"

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
