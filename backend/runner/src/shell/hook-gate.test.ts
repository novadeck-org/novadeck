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

describe("a hook the shipping gate answers", () => {
  it("carries the whole raw command, past what a report keeps", () => {
    const command = `gh pr create --body "${"x".repeat(70_000)}"`
    const read = relayHook(
      hook("claude", "PreToolUse", {
        tool_name: "Bash",
        tool_input: { command },
        cwd: "/w",
        permission_mode: "auto",
      }),
      undefined,
      on,
    )
    expect(read?.gate).toEqual({ event: "PreToolUse", command, cwd: "/w", mode: "auto" })
    expect(read?.deadline).toBeTypeOf("number")
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
          cwd: "/w",
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
    expect(folder({ workdir: "/other/repo" }, "/w")).toBe("/other/repo")
    expect(folder({ workdir: "sub" }, "/w")).toBe("/w/sub")
    expect(folder({ workdir: "" }, "/w")).toBe("/w")
    expect(folder({}, "/w")).toBe("/w")
    // An empty or missing session folder is not the runner's own.
    expect(folder({}, "")).toBeUndefined()
    expect(folder({})).toBeUndefined()
    expect(folder({ workdir: "sub" })).toBeUndefined()
    expect(folder({ workdir: "/abs" })).toBe("/abs")
  })
})
