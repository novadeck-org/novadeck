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

  it("lists a patch's files in order, once each", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: z.ts",
      "*** Add File: a.ts",
      "*** Update File: z.ts",
      "*** Delete File: m.ts",
      "*** End Patch",
    ].join("\n")
    expect(run("apply_patch", patch).detail).toBe("z.ts, a.ts +1")
    expect(run("apply_patch", patch.replace("*** Delete File: m.ts\n", "")).detail).toBe(
      "z.ts, a.ts",
    )
  })

  it("counts an updated plan's steps", () => {
    expect(run("update_plan", { plan: [{}, {}] }).detail).toBe("2 steps")
  })

  it("shows a question by its first question, waiting or not", () => {
    const asked = { kind: "plan", title: "Asked", detail: "Which color should the button be?" }
    expect(
      run("request_user_input", {
        questions: [
          { id: "color", header: "Color", question: "Which color should the button be?" },
          { id: "label", header: "Label", question: "What should its label say?" },
        ],
      }),
    ).toEqual(asked)
    expect(
      run("request_user_input_async", {
        questions: [
          { title: "Which color should the button be?", options: ["Blue", "Green"] },
          { title: "What should its label say?" },
        ],
      }),
    ).toEqual(asked)
    expect(run("request_user_input", { questions: [] })).toEqual({ ...asked, detail: "" })
    expect(run("request_user_input_async", "not json")).toEqual({ ...asked, detail: "" })
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
