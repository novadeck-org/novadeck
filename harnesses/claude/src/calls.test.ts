import type { Report } from "@novadeck/harness-core/report"
import { describe, expect, it } from "vitest"

import { hook } from "./report.test-support.js"
import { kindOf } from "./tools.js"

const called = (event: string, payload: Report["payload"]) =>
  hook(event, payload).filter(({ type }) => type === "tool-called")

describe("a Claude Code tool call", () => {
  it.each([
    ["mcp__plugin_novadeck_novadeck__send", {}, "novadeck"],
    ["mcp__plugin_novadeck_novadeck__a_tool_added_later", {}, "novadeck"],
    ["ToolSearch", {}, "bookkeeping"],
    ["Skill", {}, "bookkeeping"],
    ["TodoWrite", {}, "bookkeeping"],
    ["TaskCreate", {}, "bookkeeping"],
    ["TaskUpdate", {}, "bookkeeping"],
    ["TaskList", {}, "bookkeeping"],
    ["TaskGet", {}, "bookkeeping"],
    ["TaskOutput", {}, "work"],
    ["TaskStop", {}, "work"],
    ["ScheduleWakeup", { delaySeconds: 60 }, "waiting"],
    ["Bash", { command: "sleep 60" }, "waiting"],
    ["Bash", { command: "sleep 5; sleep 5 && sleep 1\nsleep 2" }, "waiting"],
    ["Bash", { command: "Start-Sleep -Seconds 5" }, "waiting"],
    ["Bash", { command: "timeout /t 5 /nobreak" }, "waiting"],
    ["Bash", { command: "sleep 60 && git status" }, "work"],
    ["Bash", { command: "timeout 30 make" }, "work"],
    ["Bash", { command: "ls" }, "work"],
    ["Bash", {}, "work"],
    ["Bash", undefined, "work"],
    ["Read", { file_path: "/a" }, "work"],
    ["Edit", { file_path: "/a" }, "work"],
    ["mcp__other__send", {}, "work"],
    ["mcp__novadeck__send", {}, "work"],
    ["mcp_plugin_novadeck_novadeck_send", {}, "work"],
    ["", {}, "work"],
    ["Sleep", { command: "sleep 5" }, "work"],
    ["bash", { command: "sleep 5" }, "work"],
  ] as const)("%s %j is %s", (tool, input, kind) => {
    expect(kindOf(tool, input)).toBe(kind)
  })

  it.each(["PostToolUse", "PostToolUseFailure"])(
    "is reported once by its %s, with its kind",
    (event) => {
      expect(called(event, { tool_name: "Bash", tool_input: { command: "sleep 5" } })).toEqual([
        {
          type: "tool-called",
          agent: "claude",
          sessionId: "s",
          instance: "7",
          startedAt: 1,
          actor: null,
          toolName: "Bash",
          kind: "waiting",
        },
      ])
    },
  )

  it("says it started background work when run_in_background is true", () => {
    const run = (input: object) =>
      called("PostToolUse", { tool_name: "Bash", tool_input: input })[0]
    expect(run({ command: "make", run_in_background: true })).toMatchObject({
      kind: "work",
      background: true,
    })
    expect(run({ command: "make", run_in_background: false })).not.toHaveProperty("background")
    expect(run({ command: "make" })).not.toHaveProperty("background")
    expect(run({ command: "make", run_in_background: "true" })).not.toHaveProperty("background")
  })

  it("names a subagent's call by its actor", () => {
    expect(
      called("PostToolUse", { tool_name: "Read", agent_id: "a1", tool_input: { file_path: "/a" } }),
    ).toMatchObject([{ actor: "a1", toolName: "Read", kind: "work" }])
  })

  it("is reported beside its file-touched and attention-resolved, not instead", () => {
    expect(
      hook("PostToolUse", {
        tool_name: "Write",
        tool_input: { file_path: "/a/b.ts" },
      }).map(({ type }) => type),
    ).toEqual(["attention-resolved", "file-touched", "tool-called"])
  })

  it("is not reported by the hooks that start or ask for it", () => {
    for (const event of ["PermissionRequest", "SessionStart", "Stop", "SubagentStart"])
      expect(called(event, { tool_name: "Bash", tool_input: { command: "ls" } })).toEqual([])
  })
})
