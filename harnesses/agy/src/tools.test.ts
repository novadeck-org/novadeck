import { describe as suite, expect, it } from "vitest"

import { describe } from "./tools.js"

const run = (tool: string, input: unknown) =>
  describe(tool, typeof input === "string" ? input : JSON.stringify(input))

suite("what an Antigravity tool call was", () => {
  it("reads arguments whose strings are JSON-quoted", () => {
    const quoted = { TargetFile: JSON.stringify("/home/user/project/README.md") }
    expect(run("write_to_file", quoted)).toEqual({
      kind: "write",
      title: "Wrote",
      detail: "…/user/project/README.md",
    })
  })

  it("reads run_command and view_file", () => {
    expect(run("run_command", { CommandLine: "ls" }).detail).toBe("ls")
    expect(run("view_file", { AbsolutePath: "/p/c.txt" }).detail).toBe("/p/c.txt")
  })

  it("reads 1.4's read_file, write_file and edit_file, which name their file as Path", () => {
    expect(run("read_file", { Path: "/p/c.txt" })).toEqual({
      kind: "read",
      title: "Read",
      detail: "/p/c.txt",
    })
    expect(run("write_file", { Path: "/p/n.md", Content: "# n" })).toEqual({
      kind: "write",
      title: "Wrote",
      detail: "/p/n.md",
    })
    expect(run("edit_file", { Path: "/p/a.ts", Target: "a", Replacement: "b" })).toEqual({
      kind: "write",
      title: "Edited",
      detail: "/p/a.ts",
    })
  })

  const send = { to: "fox", text: "Tests are green.\nShip it." }
  const labelled = { kind: "agent", title: "Messaged fox", detail: "Tests are green." }
  const lazy = { ServerName: "novadeck_novadeck", ToolName: "send", toolAction: "Calling send" }

  it("reads the lazy call, its arguments as an object or as text", () => {
    expect(run("call_mcp_tool", { ...lazy, Arguments: send })).toEqual(labelled)
    expect(run("call_mcp_tool", { ...lazy, Arguments: JSON.stringify(send) })).toEqual(labelled)
  })

  it("reads the eagerly loaded tools", () => {
    expect(run("mcp_novadeck_novadeck_send", { ...send, toolSummary: "send call" })).toEqual(
      labelled,
    )
  })

  it.each([
    ["agents", {}, "agent", "Listed agents", ""],
    [
      "open_agent",
      { agent: "codex", message: "Fix the lint\nerrors", model: "gpt-5", effort: "high" },
      "agent",
      "Opened an agent",
      "codex: Fix the lint",
    ],
    ["open_terminal", { command: "pnpm dev" }, "agent", "Opened a terminal", "pnpm dev"],
    ["close_terminal", { to: "owl" }, "agent", "Close owl", ""],
    [
      "show",
      { page: { url: "http://localhost:5173/" } },
      "web",
      "Showed",
      "http://localhost:5173/",
    ],
    ["show", { file: { path: "/a/b/c/d/mock.png" } }, "read", "Showed", "…/c/d/mock.png"],
    ["close", { file: { path: "/a/b/c/d/mock.png" } }, "read", "Closed", "…/c/d/mock.png"],
    [
      "close",
      { page: { url: "http://localhost:5173/" } },
      "web",
      "Closed",
      "http://localhost:5173/",
    ],
    ["show", { file: '{"path":"/a/b/c/d/mock.png"}' }, "read", "Showed", "…/c/d/mock.png"],
    ["showing", {}, "read", "Checked what's shown", ""],
    [
      "summarize",
      { summary: "Fixing the cart rounding" },
      "agent",
      "Summarized this terminal",
      "Fixing the cart rounding",
    ],
  ])("labels Novadeck's %s, eager or lazy", (tool, input, kind, title, detail) => {
    const expected = { kind, title, detail }
    expect(run(`mcp_novadeck_novadeck_${tool}`, input)).toEqual(expected)
    expect(
      run("call_mcp_tool", { ServerName: "novadeck_novadeck", ToolName: tool, Arguments: input }),
    ).toEqual(expected)
  })

  it("shows another server's lazy tool by its name and server", () => {
    expect(
      run("call_mcp_tool", {
        ServerName: "db",
        ToolName: "query",
        Arguments: { query: "select 1" },
      }),
    ).toEqual({ kind: "other", title: "query", detail: "db" })
  })

  it("leaves a server only named like Novadeck's alone", () => {
    expect(
      run("call_mcp_tool", { ServerName: "my_novadeck", ToolName: "send", Arguments: send }),
    ).toEqual({ kind: "other", title: "send", detail: "my_novadeck" })
  })

  it("shows a tool it doesn't know by its name and the first thing its input says", () => {
    expect(run("mcp_db_query", { query: "select 1" })).toMatchObject({
      kind: "other",
      title: "mcp_db_query",
      detail: "select 1",
    })
    expect(run("mystery", "first line\nsecond")).toMatchObject({ detail: "first line" })
  })
})
