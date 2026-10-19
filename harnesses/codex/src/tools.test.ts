import { describe as suite, expect, it } from "vitest"

import { describe } from "./tools.js"

const run = (tool: string, input: unknown) =>
  describe(tool, typeof input === "string" ? input : JSON.stringify(input))

suite("what a Codex tool call was", () => {
  it("reads exec_command's command", () => {
    expect(run("exec_command", { cmd: "ls -la", workdir: "/x" })).toEqual({
      kind: "run",
      title: "Ran",
      detail: "ls -la",
    })
  })

  it("unwraps a shell command list run through bash -lc", () => {
    expect(run("shell", { command: ["bash", "-lc", "git status"] }).detail).toBe("git status")
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
    expect(run("apply_patch", patch)).toEqual({
      kind: "write",
      title: "Patched",
      detail: "src/a.ts, src/b.ts +2",
    })
    expect(run("apply_patch", { input: patch }).detail).toBe("src/a.ts, src/b.ts +2")
  })

  it("counts an updated plan's steps", () => {
    expect(run("update_plan", { plan: [{}, {}] }).detail).toBe("2 steps")
  })

  const send = { to: "fox", text: "Tests are green.\nShip it." }
  const labelled = { kind: "agent", title: "Messaged fox", detail: "Tests are green." }

  it("reads Novadeck's tools in both of its spellings", () => {
    expect(run("mcp__novadeck__send", send)).toEqual(labelled)
    expect(run("mcp__novadeck.send", send)).toEqual(labelled)
    expect(run("mcp__novadeck__agents", {})).toMatchObject({ title: "Listed agents" })
  })

  it("leaves another server's tool alone", () => {
    expect(run("mcp__db__send", { to: "fox" })).toMatchObject({ title: "mcp__db__send" })
    expect(run("mcp__novadeck__new", "{}")).toMatchObject({ title: "mcp__novadeck__new" })
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
