import { context, describe, expect, it } from "../test"
import type { ChatItem } from "./conversation"
import {
  agentName,
  groupItems,
  inputText,
  patchFiles,
  sameBlock,
  toolSummary,
  turnStatus,
} from "./conversation-turns"

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
  ...fields,
})
const call = (tool: string, id: string | null, text = "{}") =>
  item({ kind: "tool-call", tool, call: id, text })
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

  it("turns Claude Code's interruption marker into a note", () => {
    const [block] = groupItems([
      item({ role: "user", text: "[Request interrupted by user for tool use]" }),
    ])
    expect(block).toMatchObject({ kind: "note", text: "Interrupted" })
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

describe("a tool call's summary", () => {
  context("for Claude Code", () => {
    it.each([
      ["Bash", { command: "pnpm test\nmore" }, "run", "Ran", "pnpm test"],
      ["Read", { file_path: "/a/b/c/d/e.ts" }, "read", "Read", "…/c/d/e.ts"],
      ["Write", { file_path: "/a/b.ts" }, "write", "Wrote", "/a/b.ts"],
      ["Edit", { file_path: "src/x.ts" }, "write", "Edited", "src/x.ts"],
      ["Grep", { pattern: "foo", path: "src" }, "search", "Searched", "foo"],
      ["Glob", { pattern: "**/*.ts" }, "search", "Found files", "**/*.ts"],
      ["Task", { description: "Explore the repo" }, "agent", "Subagent", "Explore the repo"],
      ["Agent", { description: "Review" }, "agent", "Subagent", "Review"],
      ["WebFetch", { url: "https://example.com" }, "web", "Fetched", "https://example.com"],
      ["TodoWrite", { todos: [{}, {}, {}] }, "plan", "Updated todos", "3 items"],
    ])("reads %s", (tool, input, kind, title, detail) => {
      expect(toolSummary(tool, JSON.stringify(input))).toEqual({ kind, title, detail })
    })
  })

  context("for Codex", () => {
    it("reads exec_command's command", () => {
      expect(toolSummary("exec_command", JSON.stringify({ cmd: "ls -la", workdir: "/x" }))).toEqual(
        {
          kind: "run",
          title: "Ran",
          detail: "ls -la",
        },
      )
    })

    it("unwraps a shell command list run through bash -lc", () => {
      const input = JSON.stringify({ command: ["bash", "-lc", "git status"] })
      expect(toolSummary("shell", input).detail).toBe("git status")
    })

    it("names the files a raw patch touches", () => {
      const patch = [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-x",
        "+y",
        "*** Add File: src/b.ts",
        "+z",
        "*** Delete File: old.ts",
        "*** Add File: c.ts",
        "*** End Patch",
      ].join("\n")
      expect(patchFiles(patch)).toEqual(["src/a.ts", "src/b.ts", "old.ts", "c.ts"])
      expect(toolSummary("apply_patch", patch)).toEqual({
        kind: "write",
        title: "Patched",
        detail: "src/a.ts, src/b.ts +2",
      })
    })

    it("counts an updated plan's steps", () => {
      expect(toolSummary("update_plan", JSON.stringify({ plan: [{}, {}] })).detail).toBe("2 steps")
    })
  })

  context("for Antigravity", () => {
    it("reads arguments whose strings are JSON-quoted", () => {
      const quoted = JSON.stringify({ TargetFile: JSON.stringify("/home/user/project/README.md") })
      expect(toolSummary("write_to_file", quoted)).toEqual({
        kind: "write",
        title: "Wrote",
        detail: "…/user/project/README.md",
      })
    })

    it("reads run_command and view_file", () => {
      expect(toolSummary("run_command", JSON.stringify({ CommandLine: "ls" })).detail).toBe("ls")
      expect(toolSummary("view_file", JSON.stringify({ AbsolutePath: "/p/c.txt" })).detail).toBe(
        "/p/c.txt",
      )
    })
  })

  context("for a tool it doesn't know", () => {
    it("shows its name and the first thing its input says", () => {
      expect(toolSummary("mcp__db__query", JSON.stringify({ query: "select 1" }))).toEqual({
        kind: "other",
        title: "mcp__db__query",
        detail: "select 1",
      })
    })

    it("falls back to the raw text's first line", () => {
      expect(toolSummary("mystery", "first line\nsecond")).toMatchObject({ detail: "first line" })
    })
  })
})

describe("a tool call's input as text", () => {
  it("is the value of a call that holds one", () => {
    expect(inputText(JSON.stringify({ command: "ls" }))).toBe("ls")
  })

  it("lists several values, strings unquoted", () => {
    expect(inputText(JSON.stringify({ a: JSON.stringify("x"), b: 2 }))).toBe("a: x\nb: 2")
  })

  it("is a patch as written", () => {
    expect(inputText("*** Begin Patch")).toBe("*** Begin Patch")
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
})
