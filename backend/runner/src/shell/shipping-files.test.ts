import { describe, expect, it } from "vitest"

import { relayConfig, shellFiles, shellPaths } from "./scripts.js"

const paths = shellPaths("/home/u/.novadeck/shell", "linux")
const files = (machine: object = {}) =>
  new Map(
    shellFiles(paths, "linux", undefined, { worktreesRoot: "/w", ...machine }).map((each) => [
      each.path,
      each.content,
    ]),
  )
const at = (all: Map<string, string>, suffix: string) =>
  [...all].find(([path]) => path.endsWith(suffix))?.[1] ?? ""

describe("the shipping gate's files", () => {
  it("are every file as they always were while the gate is off", () => {
    const off = files()
    expect(files({ shippingGate: undefined })).toEqual(off)
    // relay.json holds only what it always did.
    expect(off.get(paths.relayConfig)).toBe(`${JSON.stringify(relayConfig, null, 2)}\n`)
    for (const name of ["statusline.json", "worktrees.json"]) {
      const settings = JSON.parse(at(off, name)) as Record<string, unknown>
      expect(Object.keys(settings)).not.toContain("hooks")
    }
    const hooks = JSON.parse(at(off, "codex/novadeck/hooks/hooks.json")) as {
      hooks: { PreToolUse: { matcher: string }[] }
    }
    expect(hooks.hooks.PreToolUse[0]!.matcher).toBe(
      "request_user_input|request_permissions|request_user_input_async",
    )
    const claude = JSON.parse(at(off, "claude/novadeck/hooks/hooks.json")) as { hooks: object }
    expect(Object.keys(claude.hooks)).not.toContain("PreToolUse")
  })

  it("add Claude's per-launch PreToolUse for Bash and Codex's wider matcher, and change nothing else", () => {
    const off = files()
    const on = files({ shippingGate: true })
    const changed = [...on]
      .filter(([path, content]) => off.get(path) !== content)
      .map(([path]) => path)
    expect(changed.map((path) => path.split("/plugins/")[1]).toSorted()).toEqual([
      "claude/statusline.json",
      "claude/worktrees.json",
      "codex/novadeck/hooks/hooks.json",
    ])
    const settings = JSON.parse(at(on, "statusline.json")) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }
    }
    expect(settings.hooks.PreToolUse[0]!.matcher).toBe("Bash")
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toContain("PreToolUse")
    const codex = JSON.parse(at(on, "codex/novadeck/hooks/hooks.json")) as {
      hooks: { PreToolUse: { matcher: string }[] }
    }
    expect(codex.hooks.PreToolUse[0]!.matcher).toContain("|Bash|")
    expect(at(on, "relay.json")).toBe(at(off, "relay.json"))
  })
})
