import { describe, expect, it } from "vitest"

import { maxCommand } from "../grants.js"
import { agyNonCommandTools, callFromPayload, isAgyNonCommandTool } from "./payload.js"

// Payload shapes as the probes captured them (approvals-probes/captures).
const claude = (input: object, extra: object = {}) => ({
  session_id: "s",
  cwd: "/tmp/novadeck-e2e-sTGnsC/project",
  permission_mode: "auto",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: input,
  tool_use_id: "toolu_1421f47e6bb3574b0f138325",
  ...extra,
})
const codex = (input: object) => ({
  session_id: "s",
  cwd: "/tmp/novadeck-e2e-eGUNd8/project",
  hook_event_name: "PermissionRequest",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: input,
})
const agy = (name: string, args: object) => ({
  conversationId: "8511b2e7-8928-436a-9819-541356cc5878",
  stepIdx: 2,
  toolCall: { name, args },
})

describe("a Claude Code PreToolUse payload", () => {
  it("reads the command and the folder it runs in", () => {
    const input = { command: "cd sub", description: "Run it", timeout: 5000 }
    expect(callFromPayload("claude", "PreToolUse", claude(input))).toEqual({
      command: "cd sub",
      cwd: "/tmp/novadeck-e2e-sTGnsC/project",
    })
  })

  it("refuses a field outside command, description and timeout", () => {
    for (const extra of [
      { dangerouslyDisableSandbox: true },
      { run_in_background: false },
      { x: 1 },
    ])
      expect(callFromPayload("claude", "PreToolUse", claude({ command: "ls", ...extra }))).toBe(
        "extra-fields",
      )
  })

  it("is not a shell call for another tool", () => {
    const payload = claude({ file_path: "/a" }, { tool_name: "Read" })
    expect(callFromPayload("claude", "PreToolUse", payload)).toBe("not-shell")
  })

  it("is unreadable when whole parts are missing or mistyped", () => {
    expect(callFromPayload("claude", "PreToolUse", claude({ command: ["ls"] }))).toBe("unreadable")
    expect(callFromPayload("claude", "PreToolUse", claude({ command: "ls", timeout: "5" }))).toBe(
      "unreadable",
    )
    expect(callFromPayload("claude", "PreToolUse", claude({}))).toBe("unreadable")
    expect(callFromPayload("claude", "PreToolUse", claude({ command: "ls" }, { cwd: 3 }))).toBe(
      "unreadable",
    )
    expect(
      callFromPayload("claude", "PreToolUse", claude({ command: "ls" }, { tool_input: null })),
    ).toBe("unreadable")
    expect(callFromPayload("claude", "PostToolUse", claude({ command: "ls" }))).toBe("unreadable")
    for (const bad of [null, "x", 4, [], undefined])
      expect(callFromPayload("claude", "PreToolUse", bad)).toBe("unreadable")
  })

  it("is too long over maxCommand", () => {
    const long = `git status ${"a".repeat(maxCommand)}`
    expect(callFromPayload("claude", "PreToolUse", claude({ command: long }))).toBe("too-long")
    const edge = "a".repeat(maxCommand)
    expect(callFromPayload("claude", "PreToolUse", claude({ command: edge }))).toMatchObject({
      command: edge,
    })
  })
})

describe("a Codex PermissionRequest payload", () => {
  it("reads the command, with no known folder", () => {
    const input = { command: "touch /x/ran.txt", description: "Touch a file outside the sandbox" }
    expect(callFromPayload("codex", "PermissionRequest", codex(input))).toEqual({
      command: "touch /x/ran.txt",
      cwd: null,
    })
  })

  it("refuses an array command, extra fields, other tools and other events", () => {
    expect(callFromPayload("codex", "PermissionRequest", codex({ command: ["ls", "-l"] }))).toBe(
      "unreadable",
    )
    expect(
      callFromPayload("codex", "PermissionRequest", codex({ command: "ls", timeout: 1 })),
    ).toBe("extra-fields")
    expect(
      callFromPayload("codex", "PermissionRequest", {
        ...codex({ command: "ls" }),
        tool_name: "apply_patch",
      }),
    ).toBe("not-shell")
    expect(callFromPayload("codex", "PreToolUse", codex({ command: "ls" }))).toBe("unreadable")
  })
})

describe("an Antigravity PreToolUse payload", () => {
  it("reads run_command's CommandLine, with no known folder", () => {
    const args = {
      CommandLine: "touch /tmp/ran.txt",
      WaitMsBeforeAsync: 5000,
      toolSummary: "Touch",
    }
    expect(callFromPayload("agy", "PreToolUse", agy("run_command", args))).toEqual({
      command: "touch /tmp/ran.txt",
      cwd: null,
    })
  })

  it("refuses IsDaemon and any other argument", () => {
    for (const extra of [{ IsDaemon: true }, { IsDaemon: false }, { Cwd: "/" }])
      expect(
        callFromPayload("agy", "PreToolUse", agy("run_command", { CommandLine: "ls", ...extra })),
      ).toBe("extra-fields")
  })

  it("is not a shell call for other tools, and unreadable without a toolCall", () => {
    expect(callFromPayload("agy", "PreToolUse", agy("manage_task", { CommandLine: "ls" }))).toBe(
      "not-shell",
    )
    expect(callFromPayload("agy", "PreToolUse", { conversationId: "c" })).toBe("unreadable")
    expect(callFromPayload("agy", "PreToolUse", agy("run_command", { CommandLine: 4 }))).toBe(
      "unreadable",
    )
  })
})

describe("Antigravity's tools known not to run commands", () => {
  it("are the closed list, plus Novadeck's own MCP tools by prefix", () => {
    expect([...agyNonCommandTools].toSorted()).toEqual([
      "ask_question",
      "edit_file",
      "list_resources",
      "read_file",
      "read_resource",
      "search_web",
      "send_message",
      "write_file",
    ])
    expect(isAgyNonCommandTool("read_file")).toBe(true)
    expect(isAgyNonCommandTool("mcp_novadeck_novadeck_ask")).toBe(true)
    for (const name of [
      "run_command",
      "manage_task",
      "schedule",
      "call_mcp_tool",
      "invoke_subagent",
      "",
    ])
      expect(isAgyNonCommandTool(name)).toBe(false)
  })
})
