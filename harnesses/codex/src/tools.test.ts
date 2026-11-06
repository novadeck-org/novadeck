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
    expect(
      run("shell", {
        command: ["C:\\WINDOWS\\powershell.exe", "-NoProfile", "-Command", "Get-ChildItem"],
      }).detail,
    ).toBe("Get-ChildItem")
    expect(run("shell", { command: ["cmd.exe", "/c", "dir"] }).detail).toBe("dir")
    // Only a shell's: another program's flag is its own.
    expect(run("shell", { command: ["grep", "-c", "x"] }).detail).toBe("grep -c x")
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
    expect(run("mcp__novadeck__describe", { title: "Cart", summary: "Rounding." })).toEqual({
      kind: "agent",
      title: "Described this terminal",
      detail: "Cart",
    })
    // Its old name, in sessions recorded before it, keeps its label.
    expect(run("mcp__novadeck__summarize", { summary: "Rounding." })).toEqual({
      kind: "agent",
      title: "Summarized this terminal",
      detail: "Rounding.",
    })
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

suite("what Codex's subagent tools were", () => {
  it.each([
    "spawn_agent",
    "multi_agent_v1.spawn_agent",
    "multi_agent_v1__spawn_agent",
    "collaborationspawn_agent",
  ])("reads %s as a subagent", (tool) => {
    expect(run(tool, { task_name: "lint", message: "Fix it" })).toEqual({
      kind: "agent",
      title: "Subagent",
      detail: "lint",
    })
    expect(run(tool, { message: "Fix it\nnow" }).detail).toBe("Fix it")
  })

  it("reads the rest of the multi_agent tools", () => {
    expect(run("multi_agent_v1__send_input", { message: "More" })).toEqual({
      kind: "agent",
      title: "Messaged a subagent",
      detail: "More",
    })
    expect(run("multi_agent_v1.wait_agent", { timeout_ms: 1 })).toMatchObject({
      kind: "agent",
      title: "Waited for a subagent",
    })
    expect(run("multi_agent_v1__close_agent", {}).title).toBe("Closed a subagent")
    expect(run("multi_agent_v1__resume_agent", {}).title).toBe("Resumed a subagent")
  })

  it("reads the collaboration namespace as a rollout records it", () => {
    expect(
      run("collaboration__spawn_agent", { task_name: "lint", agent_type: "worker", message: "Go" }),
    ).toEqual({ kind: "agent", title: "Subagent", detail: "lint" })
    expect(run("collaboration__spawn_agent", { agent_type: "worker", message: "Go" }).detail).toBe(
      "worker",
    )
    expect(
      run("collaboration__send_message", { target: "/root/lint", message: "Hi\nthere" }),
    ).toEqual({
      kind: "agent",
      title: "Messaged /root/lint",
      detail: "Hi",
    })
    expect(
      run("collaboration__followup_task", { target: "/root/lint", message: "Also docs" }),
    ).toEqual({
      kind: "agent",
      title: "Followed up with /root/lint",
      detail: "Also docs",
    })
    expect(run("collaboration__list_agents", {})).toEqual({
      kind: "agent",
      title: "Listed subagents",
      detail: "",
    })
    expect(run("collaboration__wait_agent", { timeout_ms: 5 }).title).toBe("Waited for a subagent")
  })

  it("reads a target given as id, and the rest of the codex tools", () => {
    expect(run("multi_agent_v1__send_input", { id: "a1", message: "x" }).title).toBe("Messaged a1")
    expect(run("multi_agent_v1__close_agent", { id: "a1" }).detail).toBe("a1")
    expect(run("clock__sleep", { duration_ms: 5 })).toMatchObject({ kind: "run", title: "Waited" })
    expect(run("mcp__codex_worktrees__list_worktrees", {}).title).toBe("Listed worktrees")
    expect(run("mcp__codex_worktrees.list_worktrees", {}).title).toBe("Listed worktrees")
    expect(run("mcp__codex_tui__list_worktrees", {}).title).toBe("Listed worktrees")
    expect(run("mcp__codex_tui.create_worktree", {}).title).toBe("Created a worktree")
    // The old namespace was never reserved: anything else there is a server's own.
    expect(run("mcp__codex_worktrees__create_thread", {}).kind).toBe("other")
    expect(run("list_mcp_resources", {}).title).toBe("Listed MCP resources")
  })

  it("reads its TUI's task tools, however the name is spelled", () => {
    expect(run("mcp__codex_tui__create_thread", { prompt: "Fix it", title: "Fixes" })).toEqual({
      kind: "agent",
      title: "Started a task",
      detail: "Fixes",
    })
    expect(run("mcp__codex_tui.create_thread", { prompt: "Fix it" }).detail).toBe("Fix it")
    expect(run("mcp__codex_tui__send_message_to_thread", { threadId: "t", prompt: "Go" })).toEqual({
      kind: "agent",
      title: "Messaged a task",
      detail: "Go",
    })
    expect(run("mcp__codex_tui__fork_thread", { threadId: "t" }).title).toBe("Forked a task")
    expect(run("mcp__codex_tui__read_thread", { threadId: "t" }).detail).toBe("t")
    expect(run("mcp__codex_tui__list_threads", {}).title).toBe("Listed tasks")
    expect(run("mcp__codex_tui__list_archived_threads", {}).title).toBe("Listed archived tasks")
    expect(run("mcp__codex_tui__wait_threads", { targets: [] }).title).toBe("Waited for tasks")
    expect(run("mcp__codex_tui__set_thread_archived", { archived: true }).title).toBe(
      "Archived a task",
    )
    expect(run("mcp__codex_tui__set_thread_archived", { archived: false }).title).toBe(
      "Restored a task",
    )
    expect(run("mcp__codex_tui__set_thread_title", { title: "New" }).detail).toBe("New")
  })

  it("reads code mode's wait on a running cell", () => {
    expect(run("wait", { cell_id: "1", yield_time_ms: 1000, max_tokens: 100 })).toEqual({
      kind: "run",
      title: "Waited",
      detail: "",
    })
  })

  it("leaves another namespace's spawn_agent alone", () => {
    expect(run("mcp__db__spawn_agent", {})).toMatchObject({
      title: "mcp__db__spawn_agent",
    })
  })

  it("reads web_search, the goal tools and request_permissions", () => {
    expect(run("web_search", { query: "vitest" })).toEqual({
      kind: "web",
      title: "Searched the web",
      detail: "vitest",
    })
    expect(run("create_goal", { objective: "Ship" })).toMatchObject({
      title: "Set a goal",
      detail: "Ship",
    })
    expect(run("request_permissions", { reason: "Write out" })).toMatchObject({
      kind: "plan",
      title: "Asked for permissions",
    })
  })
})
