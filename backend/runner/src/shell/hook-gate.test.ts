import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { relayHook } from "./hook.js"

const hook = (agent: string, event: string, payload: object) => ({
  agent,
  event,
  seq: Date.now(),
  deadline: Date.now() + 2000,
  payload: JSON.stringify({ hook_event_name: event, ...payload }),
})
const on = () => true
// Whole paths as the platform spells them.
const abs = (path: string) => resolve(path)

describe("a hook the shipping gate answers", () => {
  it("carries the whole raw command, past what a report keeps", () => {
    const command = `gh pr create --body "${"x".repeat(70_000)}"`
    const read = relayHook(
      hook("claude", "PreToolUse", {
        tool_name: "Bash",
        tool_input: { command },
        cwd: abs("/w"),
        permission_mode: "auto",
      }),
      undefined,
      on,
    )
    expect(read?.gate).toEqual({ event: "PreToolUse", command, cwd: abs("/w"), mode: "auto" })
    expect(read?.deadline).toBeTypeOf("number")
  })

  it("reads Antigravity's run_command, from its toolCall, with the words it was launched with", () => {
    const read = (toolCall: unknown, ancestors?: unknown) =>
      relayHook(
        {
          ...hook("agy", "PreToolUse", { toolCall, cwd: abs("/w") }),
          ...(ancestors !== undefined && { ancestors }),
        },
        undefined,
        on,
      )?.gate
    const run = { name: "run_command", args: { CommandLine: "git push origin main" } }
    expect(read(run)).toEqual({
      event: "PreToolUse",
      command: "git push origin main",
      cwd: abs("/w"),
    })
    expect(read({ ...run, args: { ...run.args, Cwd: abs("/x") } })?.cwd).toBe(abs("/x"))
    expect(read({ name: "write_file", args: { Path: "a" } })).toBeUndefined()
    expect(read({ name: "run_command", args: {} })).toBeUndefined()
    const launched = read(run, [{ pid: 7, name: "agy", args: ["--mode", "plan"] }])
    expect(launched?.launch).toEqual(["--mode", "plan"])
    expect(launched?.instance).toBe("7")
    // Its step names the call's confirmation; the gate reads the raw command, never a pruned one.
    const stepped = relayHook(
      hook("agy", "PreToolUse", { toolCall: run, cwd: abs("/w"), stepIdx: 12 }),
      undefined,
      on,
    )?.gate
    expect(stepped?.step).toBe(12)
  })

  it("reads opencode's bash call and its permission's request, with the session and call that tie them", () => {
    const read = (event: string, payload: object, ancestors?: unknown) =>
      relayHook(
        {
          ...hook("opencode", event, { cwd: abs("/w"), session_id: "ses_1", ...payload }),
          ...(ancestors !== undefined && { ancestors }),
        },
        undefined,
        on,
      )?.gate
    const call = {
      tool_name: "bash",
      call_id: "toolu_1",
      tool_input: { command: "gh pr create --body x", description: "d" },
    }
    expect(read("PreToolUse", call)).toEqual({
      event: "PreToolUse",
      command: "gh pr create --body x",
      cwd: abs("/w"),
      conversation: "ses_1",
      call: "toolu_1",
    })
    // Its `workdir`, relative to the session's folder, is where it runs.
    expect(
      read("PreToolUse", { ...call, tool_input: { ...call.tool_input, workdir: "sub" } })?.cwd,
    ).toBe(abs("/w/sub"))
    // Any other tool is no shell command, whatever its input holds; a call with no id still has
    // its command read (the deny doesn't need it), but names no call.
    expect(read("PreToolUse", { ...call, tool_name: "read" })).toBeUndefined()
    expect(read("PreToolUse", { tool_name: "bash", tool_input: {} })).toBeUndefined()
    const unnamed = read("PreToolUse", { ...call, call_id: undefined })
    expect(unnamed?.command).toBe("gh pr create --body x")
    expect(unnamed?.call).toBeUndefined()
    // The permission's request names the raw command in its metadata, and the call it is for.
    const asked = {
      permission: "bash",
      patterns: ["gh pr create *"],
      metadata: { command: "gh pr create --body x" },
      tool: { messageID: "msg_1", callID: "toolu_1" },
    }
    expect(read("PermissionRequest", asked)).toEqual({
      event: "PermissionRequest",
      command: "gh pr create --body x",
      cwd: abs("/w"),
      conversation: "ses_1",
      call: "toolu_1",
    })
    // Another permission (a file, a folder, an MCP tool) is no shell command.
    expect(read("PermissionRequest", { ...asked, permission: "edit" })).toBeUndefined()
    expect(
      read("PermissionRequest", { ...asked, permission: "external_directory" }),
    ).toBeUndefined()
    // The words it was launched with are carried, which say whether it skips every permission.
    const launched = read("PreToolUse", call, [{ pid: 9, name: "opencode", args: ["--auto"] }])
    expect(launched?.launch).toEqual(["--auto"])
    expect(launched?.instance).toBe("9")
  })

  it("is a plain report, as it always was, while the gate is off", () => {
    const value = hook("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } })
    expect(relayHook(value)?.gate).toBeUndefined()
    expect(relayHook(value)?.deadline).toBeUndefined()
    expect(relayHook(value, undefined, () => false)?.deadline).toBeUndefined()
  })

  it("reads Codex's command as a string or as a shell's script", () => {
    const read = (command: unknown) =>
      relayHook(
        hook("codex", "PermissionRequest", {
          tool_name: "Bash",
          tool_input: { command },
          cwd: abs("/w"),
          transcript_path: "/r.jsonl",
        }),
        undefined,
        on,
      )?.gate?.command
    expect(read("git push")).toBe("git push")
    expect(read(["bash", "-lc", "gh pr merge 1"])).toBe("gh pr merge 1")
    expect(read(["git", "push"])).toBe("git push")
    expect(read(7)).toBeUndefined()
  })

  it("runs a Codex command in its `workdir` where the tool names one, and has no opinion without a whole folder", () => {
    const folder = (input: object, cwd?: string) =>
      relayHook(
        hook("codex", "PreToolUse", {
          tool_name: "Bash",
          tool_input: { command: "git push", ...input },
          ...(cwd !== undefined && { cwd }),
        }),
        undefined,
        on,
      )?.gate?.cwd
    expect(folder({ workdir: abs("/other/repo") }, abs("/w"))).toBe(abs("/other/repo"))
    expect(folder({ workdir: "sub" }, abs("/w"))).toBe(resolve(abs("/w"), "sub"))
    expect(folder({ workdir: "" }, abs("/w"))).toBe(abs("/w"))
    expect(folder({}, abs("/w"))).toBe(abs("/w"))
    // An empty or missing session folder is not the runner's own.
    expect(folder({}, "")).toBeUndefined()
    expect(folder({})).toBeUndefined()
    expect(folder({ workdir: "sub" })).toBeUndefined()
    expect(folder({ workdir: abs("/abs") })).toBe(abs("/abs"))
  })
})
