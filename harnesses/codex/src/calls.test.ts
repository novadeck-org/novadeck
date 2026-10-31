import type { Report } from "@novadeck/harness-core/report"
import { describe, expect, it } from "vitest"

import { hook } from "./report.test-support.js"
import { rolloutEvents } from "./rollout.js"
import { kindOf } from "./tools.js"

const called = (event: string, payload: Report["payload"]) =>
  hook(event, payload).filter(({ type }) => type === "tool-called")

describe("a Codex tool call", () => {
  it.each([
    ["mcp__novadeck__send", {}, "novadeck"],
    ["mcp__novadeck__a_tool_added_later", {}, "novadeck"],
    ["mcp__novadeck.send", {}, "novadeck"],
    ["mcp__novadeck_2__send", {}, "work"],
    ["mcp__novadeck_e0598e406614__send", {}, "work"],
    ["mcp__other__send", {}, "work"],
    ["mcp__plugin_novadeck_novadeck__send", {}, "work"],
    ["update_plan", { plan: [] }, "bookkeeping"],
    ["Bash", { command: "sleep 30" }, "waiting"],
    ["Bash", { command: "sleep 1\nsleep 2" }, "waiting"],
    ["Bash", { command: "sleep 60 && git status" }, "work"],
    ["shell", { command: ["bash", "-lc", "sleep 5"] }, "waiting"],
    ["shell", { command: ["bash", "-lc", "sleep 5; sleep 1\nsleep 2"] }, "waiting"],
    ["shell", { command: ["bash", "-lc", "sleep 5 && ls"] }, "work"],
    ["shell", { command: ["sleep", "5"] }, "waiting"],
    ["shell", { command: ["timeout", "30", "make"] }, "work"],
    ["exec_command", { cmd: "sleep 5" }, "waiting"],
    ["exec_command", { cmd: "ls" }, "work"],
    ["shell_command", { command: "Start-Sleep -Seconds 5" }, "waiting"],
    ["apply_patch", { input: "*** Begin Patch" }, "work"],
    ["web_search", {}, "work"],
    ["request_user_input", {}, "work"],
    ["Bash", undefined, "work"],
    ["Bash", "sleep 5", "work"],
    ["", {}, "work"],
  ] as const)("%s %j is %s", (tool, input, kind) => {
    expect(kindOf(tool, input)).toBe(kind)
  })

  it("is reported once by its PostToolUse, with its kind", () => {
    expect(
      called("PostToolUse", { tool_name: "mcp__novadeck__send", tool_input: { to: "x" } }),
    ).toEqual([
      {
        type: "tool-called",
        agent: "codex",
        sessionId: "s",
        instance: "7",
        startedAt: 1,
        actor: null,
        toolName: "mcp__novadeck__send",
        kind: "novadeck",
      },
    ])
  })

  it("names a subagent's call by its actor, beside a patch's file-touched", () => {
    const events = hook("PostToolUse", {
      tool_name: "apply_patch",
      agent_id: "a1",
      cwd: "/w",
      tool_input: { input: "*** Update File: x.ts" },
    })
    expect(events.map(({ type }) => type)).toEqual([
      "attention-resolved",
      "file-touched",
      "tool-called",
    ])
    expect(events.at(-1)).toMatchObject({ actor: "a1", toolName: "apply_patch", kind: "work" })
  })

  it("names no folder by its hook, which tells only the turn's directory, never its workdir", () => {
    const [shell] = called("PostToolUse", {
      tool_name: "Bash",
      cwd: "/w/a",
      tool_input: { command: "cargo test" },
    })
    expect(shell).not.toHaveProperty("folder")
  })

  it("tells the folder a command ran in from its rollout: its own directory, or a leading cd", () => {
    const run = { sessionId: "s", instance: "7" }
    const executed = (item: object) =>
      rolloutEvents(
        JSON.stringify({
          timestamp: "2026-10-31T10:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: { type: "CommandExecution", status: "completed", ...item },
          },
        }),
        run,
      )
    expect(
      executed({
        command: ["/bin/bash", "-lc", "cargo test"],
        cwd: "file:///w/api",
        source: "unified_exec_startup",
      }),
    ).toMatchObject([{ type: "command-ran", folder: "/w/api" }])
    // A Windows Codex's folder, by Windows' rules whatever system runs the runner.
    expect(
      executed({ command: ["/bin/bash", "-lc", "cargo test"], cwd: "file:///D:/w%20x/api" }),
    ).toMatchObject([{ type: "command-ran", folder: "D:\\w x\\api" }])
    expect(
      executed({ command: ["/bin/bash", "-lc", "cd ..\\b; ls"], cwd: "C:\\w\\a" }),
    ).toMatchObject([{ type: "command-ran", folder: "C:\\w\\b" }])
    expect(executed({ command: ["/bin/bash", "-lc", "cd ../b && ls"], cwd: "/w/a" })).toMatchObject(
      [{ type: "command-ran", folder: "/w/b" }],
    )
    // The person's own `!` command, and one with no folder to tell, are none of the agent's.
    expect(
      executed({ command: ["/bin/bash", "-lc", "ls"], cwd: "file:///w", source: "user_shell" }),
    ).toEqual([])
    expect(executed({ command: ["ls"], cwd: "relative" })).toEqual([])
  })

  it("is not reported by the hooks that ask for it", () => {
    for (const event of ["PermissionRequest", "PreToolUse", "Stop"])
      expect(
        called(event, { tool_name: "request_user_input", tool_input: { questions: [] } }),
      ).toEqual([])
  })

  it("is not reported from the rollout", () => {
    const record = (payload: object) =>
      JSON.stringify({ timestamp: "2026-10-15T06:18:46.764Z", type: "response_item", payload })
    const lines = [
      record({
        type: "function_call",
        name: "exec_command",
        call_id: "c1",
        arguments: '{"cmd":"sleep 5"}',
      }),
      record({ type: "function_call_output", call_id: "c1", output: "ok" }),
      JSON.stringify({
        timestamp: "2026-10-15T06:18:46.764Z",
        type: "event_msg",
        payload: { type: "patch_apply_end", call_id: "c2", success: true, changes: {} },
      }),
    ]
    const events = lines.flatMap((line) => rolloutEvents(line, { sessionId: "s", instance: "7" }))
    expect(events.filter(({ type }) => type === "tool-called")).toEqual([])
  })
})
