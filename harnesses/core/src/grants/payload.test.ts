import { describe, expect, it } from "vitest"

import { maxCommand } from "../grants.js"
import {
  agyNonCommandTools,
  callFromPayload,
  isAgyNonCommandTool,
  novadeckMcpTools,
} from "./payload.js"

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
  turn_id: "01a198d1-eb71",
  transcript_path: "/h/.codex/sessions/2026/10/31/rollout-2026-10-31T18-52-12-01a1.jsonl",
  hook_event_name: "PermissionRequest",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: input,
})
const codexRollout = "/h/.codex/sessions/2026/10/31/rollout-2026-10-31T18-52-12-01a1.jsonl"
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
  it("reads the command, with no known folder but the session's", () => {
    const input = { command: "touch /x/ran.txt", description: "Touch a file outside the sandbox" }
    expect(callFromPayload("codex", "PermissionRequest", codex(input), "linux")).toEqual({
      command: "touch /x/ran.txt",
      cwd: null,
      sessionFolder: "/tmp/novadeck-e2e-eGUNd8/project",
      folderHidden: true,
      rollout: { path: codexRollout, turn: "01a198d1-eb71" },
    })
  })

  it("is unreadable on Windows without the session's folder, which cmd runs programs from", () => {
    const { cwd: _cwd, ...unnamed } = codex({ command: "ls" })
    expect(callFromPayload("codex", "PermissionRequest", unnamed, "win32")).toBe("unreadable")
    expect(callFromPayload("codex", "PermissionRequest", unnamed, "linux")).toEqual({
      command: "ls",
      cwd: null,
      folderHidden: true,
      rollout: { path: codexRollout, turn: "01a198d1-eb71" },
    })
    expect(callFromPayload("codex", "PermissionRequest", { ...unnamed, cwd: 3 }, "win32")).toBe(
      "unreadable",
    )
  })

  it("marks Codex's and Antigravity's call as Windows' on win32, and not Claude Code's", () => {
    const input = { command: "gh pr ready 1 -R o/n" }
    expect(callFromPayload("codex", "PermissionRequest", codex(input), "win32")).toEqual({
      command: "gh pr ready 1 -R o/n",
      cwd: null,
      dialect: "windows-quote-free",
      sessionFolder: "/tmp/novadeck-e2e-eGUNd8/project",
      folderHidden: true,
      rollout: { path: codexRollout, turn: "01a198d1-eb71" },
    })
    for (const platform of ["linux", "darwin"] as const)
      expect(callFromPayload("codex", "PermissionRequest", codex(input), platform)).toEqual({
        command: "gh pr ready 1 -R o/n",
        cwd: null,
        sessionFolder: "/tmp/novadeck-e2e-eGUNd8/project",
        folderHidden: true,
        rollout: { path: codexRollout, turn: "01a198d1-eb71" },
      })
    expect(callFromPayload("claude", "PreToolUse", claude(input), "win32")).toMatchObject({
      cwd: "/tmp/novadeck-e2e-sTGnsC/project",
    })
    expect(callFromPayload("claude", "PreToolUse", claude(input), "win32")).not.toHaveProperty(
      "dialect",
    )
    expect(
      callFromPayload("agy", "PreToolUse", agy("run_command", { CommandLine: "ls" }), "win32"),
    ).toEqual({ command: "ls", cwd: null, dialect: "windows-quote-free" })
    expect(
      callFromPayload("agy", "PreToolUse", agy("run_command", { CommandLine: "ls" }), "linux"),
    ).toEqual({ command: "ls", cwd: null })
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
    expect(callFromPayload("agy", "PreToolUse", agy("run_command", args), "linux")).toEqual({
      command: "touch /tmp/ran.txt",
      cwd: null,
    })
  })

  it("takes its one workspace as the folder its commands run in", () => {
    const call = (paths: unknown) => ({
      ...agy("run_command", { CommandLine: "ls" }),
      workspacePaths: paths,
    })
    expect(callFromPayload("agy", "PreToolUse", call(["/w/a"]), "linux")).toEqual({
      command: "ls",
      cwd: null,
      sessionFolder: "/w/a",
    })
    // Several, none or something else name no one folder.
    for (const paths of [["/w/a", "/w/b"], [], "/w/a", [3]])
      expect(callFromPayload("agy", "PreToolUse", call(paths), "linux")).toEqual({
        command: "ls",
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

  it("take Novadeck's own MCP tools by the server's exact name and a closed list of tool names", () => {
    for (const tool of novadeckMcpTools) {
      expect(isAgyNonCommandTool(`mcp_novadeck_novadeck_${tool}`), tool).toBe(true)
      expect(
        isAgyNonCommandTool("call_mcp_tool", { ServerName: "novadeck_novadeck", ToolName: tool }),
        tool,
      ).toBe(true)
    }
    // A lookalike server, an unknown tool of the right server, and other servers' tools.
    for (const name of [
      "mcp_novadeck_novadeck2_done",
      "mcp_novadeck_novadeck_",
      "mcp_novadeck_novadeck_unknown",
      "mcp_novadeck_novadeck_done2",
      "mcp_novadeck_novadeck__done",
      "mcp_other_server_done",
      "mcp_novadeck_other_done",
      "MCP_NOVADECK_NOVADECK_DONE",
    ])
      expect(isAgyNonCommandTool(name), name).toBe(false)
    const via = (args: unknown) => isAgyNonCommandTool("call_mcp_tool", args)
    expect(via({ ServerName: "novadeck_novadeck2", ToolName: "done" })).toBe(false)
    expect(via({ ServerName: "novadeck_novadeck/", ToolName: "done" })).toBe(false)
    expect(via({ ServerName: "other", ToolName: "done" })).toBe(false)
    expect(via({ ServerName: "novadeck_novadeck", ToolName: "unknown" })).toBe(false)
    expect(via({ ServerName: "novadeck_novadeck", ToolName: "" })).toBe(false)
    expect(via({ ServerName: "novadeck_novadeck" })).toBe(false)
    expect(via({ ToolName: "done" })).toBe(false)
    expect(via({ ServerName: ["novadeck_novadeck"], ToolName: "done" })).toBe(false)
    expect(via(undefined)).toBe(false)
    expect(via(null)).toBe(false)
    // open_terminal asks the person itself when it carries a command (the runner's approval), so
    // it is one of Novadeck's tools in either form.
    expect(novadeckMcpTools.has("open_terminal")).toBe(true)
    expect(isAgyNonCommandTool("mcp_novadeck_novadeck_open_terminal")).toBe(true)
    expect(
      isAgyNonCommandTool("call_mcp_tool", {
        ServerName: "novadeck_novadeck",
        ToolName: "open_terminal",
      }),
    ).toBe(true)
    // Antigravity reads the argument keys without regard to case: a variant is no match.
    for (const args of [
      { ServerName: "novadeck_novadeck", ToolName: "done", toolname: "open_terminal" },
      { ServerName: "novadeck_novadeck", ToolName: "done", TOOLNAME: "x" },
      { ServerName: "novadeck_novadeck", ToolName: "done", servername: "other" },
      { servername: "novadeck_novadeck", ToolName: "done" },
      { ServerName: "novadeck_novadeck", toolName: "done" },
    ])
      expect(isAgyNonCommandTool("call_mcp_tool", args), JSON.stringify(args)).toBe(false)
    // Only call_mcp_tool names its target in its arguments.
    expect(
      isAgyNonCommandTool("run_command", { ServerName: "novadeck_novadeck", ToolName: "done" }),
    ).toBe(false)
  })
})
