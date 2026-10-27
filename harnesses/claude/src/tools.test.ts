import { describe as suite, expect, it } from "vitest"

import { describe } from "./tools.js"

const run = (tool: string, input: unknown) =>
  describe(tool, typeof input === "string" ? input : JSON.stringify(input))

suite("what a Claude Code tool call was", () => {
  it.each([
    ["Bash", { command: "pnpm test\nmore" }, "run", "Ran", "pnpm test"],
    ["PowerShell", { command: "dotnet test\nmore" }, "run", "Ran", "dotnet test"],
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
    expect(run(tool, input)).toEqual({ kind, title, detail })
  })

  const send = { to: "fox", text: "Tests are green.\nShip it." }

  it("reads Novadeck's plugin tools", () => {
    expect(run("mcp__plugin_novadeck_novadeck__send", send)).toEqual({
      kind: "agent",
      title: "Messaged fox",
      detail: "Tests are green.",
    })
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
    [
      "open_agent",
      { agent: "claude", resume: "abc-123" },
      "agent",
      "Resumed an agent",
      "claude (resumed abc-123)",
    ],
    ["open_agent", { agent: "claude", effort: "high" }, "agent", "Opened an agent", "claude"],
    ["open_terminal", { command: "pnpm dev" }, "agent", "Opened a terminal", "pnpm dev"],
    ["close_terminal", { to: "owl" }, "agent", "Close owl", ""],
    [
      "lead",
      { to: "owl", message: "Fix the lint\nerrors" },
      "agent",
      "Asked to lead owl",
      "Fix the lint",
    ],
    ["release", { to: "owl" }, "agent", "Released owl", ""],
    [
      "show",
      { page: { url: "http://localhost:5173/" } },
      "web",
      "Showed",
      "http://localhost:5173/",
    ],
    ["show", { file: { path: "/a/b/c/d/mock.png" } }, "read", "Showed", "…/c/d/mock.png"],
    ["show", { file: '{"path":"/a/b/c/d/mock.png"}' }, "read", "Showed", "…/c/d/mock.png"],
    ["show", { changes: {} }, "read", "Showed", "the changes"],
    ["close", { changes: {} }, "read", "Closed", "the changes"],
    ["close", { file: { path: "/a/b/c/d/mock.png" } }, "read", "Closed", "…/c/d/mock.png"],
    [
      "close",
      { page: { url: "http://localhost:5173/" } },
      "web",
      "Closed",
      "http://localhost:5173/",
    ],
    ["showing", {}, "read", "Checked what's shown", ""],
    [
      "summarize",
      { summary: "Fixing the cart rounding" },
      "agent",
      "Summarized this terminal",
      "Fixing the cart rounding",
    ],
  ])("labels Novadeck's %s", (tool, input, kind, title, detail) => {
    expect(run(`mcp__plugin_novadeck_novadeck__${tool}`, input)).toEqual({ kind, title, detail })
  })

  it("leaves a server only named like Novadeck's alone", () => {
    for (const name of [
      "mcp__plugin_acme_novadeck__send",
      "mcp__my_novadeck__send",
      "mcp__novadeck_extra__send",
    ])
      expect(run(name, send)).toMatchObject({ title: name })
  })

  it("leaves another server's tool, and a Novadeck tool it doesn't know, as they are", () => {
    expect(run("mcp__db__send", { to: "fox" })).toMatchObject({ title: "mcp__db__send" })
    expect(run("mcp__plugin_novadeck_novadeck__new", "{}")).toMatchObject({
      title: "mcp__plugin_novadeck_novadeck__new",
    })
  })

  it("shows a tool it doesn't know by its name and the first thing its input says", () => {
    expect(run("mcp__db__query", { query: "select 1" })).toEqual({
      kind: "other",
      title: "mcp__db__query",
      detail: "select 1",
    })
    expect(run("mystery", "first line\nsecond")).toMatchObject({ detail: "first line" })
  })
})
