import type { Report } from "@novadeck/harness-core/report"
import { describe, expect, it } from "vitest"

import { hook } from "./report.test-support.js"
import { kindOf } from "./tools.js"

const called = (event: string, payload: Report["payload"]) =>
  hook(event, payload).filter(({ type }) => type === "tool-called")

describe("an Antigravity tool call", () => {
  it.each([
    ["call_mcp_tool", { ServerName: "novadeck_novadeck", ToolName: "send" }, "novadeck"],
    ["call_mcp_tool", { ServerName: '"novadeck_novadeck"', ToolName: "new_tool" }, "novadeck"],
    ["call_mcp_tool", { ServerName: "novadeck", ToolName: "send" }, "work"],
    ["call_mcp_tool", { ServerName: "other", ToolName: "send" }, "work"],
    ["call_mcp_tool", {}, "work"],
    ["read_file", { file_path: "/h/.agy/mcp/novadeck_novadeck/tools/send.json" }, "novadeck"],
    ["read_file", { AbsolutePath: "/h/.agy/mcp/novadeck_novadeck/server.json" }, "novadeck"],
    ["read_file", { file_path: "C:\\Users\\a\\mcp\\novadeck_novadeck\\send.json" }, "novadeck"],
    ["read_file", { file_path: "/h/.agy/mcp/other/send.json" }, "work"],
    ["read_file", { file_path: "/h/.agy/mcp/novadeck_novadeck_x/send.json" }, "work"],
    ["read_file", { file_path: "/h/src/novadeck_novadeck/a.ts" }, "work"],
    ["read_file", {}, "work"],
    ["run_command", { CommandLine: "sleep 30" }, "waiting"],
    ["run_command", { CommandLine: '"sleep 30"' }, "waiting"],
    ["run_command", { CommandLine: "Start-Sleep -Seconds 3" }, "waiting"],
    ["run_command", { CommandLine: "timeout /t 3 /nobreak" }, "waiting"],
    ["run_command", { CommandLine: "sleep 60 && git status" }, "work"],
    ["run_command", {}, "work"],
    ["write_file", { file_path: "/a" }, "work"],
    ["ask_question", {}, "work"],
    ["mcp_novadeck_novadeck_send", {}, "work"],
  ] as const)("%s %j is %s", (tool, args, kind) => {
    expect(kindOf(tool, args)).toBe(kind)
  })

  it("is reported once by its PreToolUse, with its kind", () => {
    expect(
      called("PreToolUse", {
        stepIdx: 3,
        toolCall: { name: "run_command", args: { CommandLine: "sleep 5" } },
      }),
    ).toEqual([
      {
        type: "tool-called",
        agent: "agy",
        sessionId: "c",
        instance: "7",
        startedAt: 1,
        actor: null,
        toolName: "run_command",
        kind: "waiting",
      },
    ])
  })

  it("tells the folder its command ran in: its Cwd, a leading cd, or the workspace's", () => {
    const ran = (args: object) =>
      called("PreToolUse", {
        workspacePaths: ["/w/a"],
        toolCall: { name: "run_command", args },
      })
    expect(ran({ CommandLine: "npm test", Cwd: "/w/b" })).toMatchObject([{ folder: "/w/b" }])
    expect(ran({ CommandLine: "npm test", Cwd: '"/w/q"' })).toMatchObject([{ folder: "/w/q" }])
    expect(ran({ CommandLine: "cd /w/c && npm test" })).toMatchObject([{ folder: "/w/c" }])
    expect(ran({ CommandLine: "npm test" })).toMatchObject([{ folder: "/w/a" }])
    // On Windows, its PowerShell's `cd` and its native workspace, whatever runs the runner.
    const ranOnWindows = (args: object) =>
      called("PreToolUse", {
        workspacePaths: ["C:\\w\\a"],
        toolCall: { name: "run_command", args },
      })
    expect(ranOnWindows({ CommandLine: "cd D:\\w\\c; npm test" })).toMatchObject([
      { folder: "D:\\w\\c" },
    ])
    expect(ranOnWindows({ CommandLine: "cd ..\\b; npm test" })).toMatchObject([
      { folder: "C:\\w\\b" },
    ])
    expect(ranOnWindows({ CommandLine: "npm test" })).toMatchObject([{ folder: "C:\\w\\a" }])
    const viewed = called("PreToolUse", {
      workspacePaths: ["/w/a"],
      toolCall: { name: "view_file", args: { AbsolutePath: "/w/a/x" } },
    })
    expect(viewed[0]).not.toHaveProperty("folder")
  })

  it("reports ask_question too, beside its question", () => {
    const events = hook("PreToolUse", {
      toolCall: {
        name: "ask_question",
        args: { questions: [{ question: "Which?", options: ["a", "b"] }] },
      },
    })
    expect(events.map(({ type }) => type)).toEqual([
      "session-observed",
      "attention-requested",
      "tool-called",
    ])
  })

  it("is not reported by its other hooks, or by a PreToolUse naming no call", () => {
    const toolCall = { name: "run_command", args: { CommandLine: "ls" } }
    for (const event of ["PostToolUse", "PreInvocation", "Stop"])
      expect(called(event, { toolCall })).toEqual([])
    expect(called("PreToolUse", {})).toEqual([])
    expect(called("PreToolUse", { toolCall: { name: "" } })).toEqual([])
  })
})
