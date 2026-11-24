import { shippingRules } from "@novadeck/harness-agy/shim"
import { describe, expect, it } from "vitest"

import { gatedRelayConfig, relayConfig, shellFiles, shellPaths } from "./scripts.js"

const paths = shellPaths("/home/u/.novadeck/shell", "linux")
const files = (machine: object = {}) =>
  new Map(
    shellFiles(paths, "linux", undefined, { worktreesRoot: "/w", ...machine }).map((each) => [
      // Joined with the host's separator: read them as slashes on Windows too.
      each.path.replaceAll("\\", "/"),
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
    expect(off.get(paths.relayConfig.replaceAll("\\", "/"))).toBe(
      `${JSON.stringify(relayConfig, null, 2)}\n`,
    )
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

  it("add Claude's per-launch PreToolUse for Bash and Codex's wider matcher, and the relay's limit, and change nothing else", () => {
    const off = files()
    const on = files({ shippingGate: true })
    const changed = [...on]
      .filter(
        ([path, content]) =>
          off.get(path) !== content && !path.endsWith("/relay.json") && !path.endsWith("/bin/agy"),
      )
      .map(([path]) => path)
    expect(changed.map((path) => path.split("/plugins/")[1]).toSorted()).toEqual([
      "claude/statusline.json",
      "claude/worktrees.json",
      "codex/novadeck/hooks/hooks.json",
      "opencode/novadeck.mjs",
      "pi/novadeck.mjs",
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
    // opencode's plugin waits for the runner's answer to a shell command, only while the gate is on.
    const plugin = (all: Map<string, string>) => at(all, "opencode/novadeck.mjs")
    expect(plugin(off)).not.toContain('"gate"')
    expect(plugin(on)).toContain('"gate":true')
    expect(plugin(on).replace(',"gate":true', "")).toBe(plugin(off))
    // …and so does pi's extension, which refuses a shell command only then.
    const piExtension = (all: Map<string, string>) => at(all, "pi/novadeck.mjs")
    expect(piExtension(off)).not.toContain('"gate":true')
    expect(piExtension(on)).toContain('"gate":true')
    // Antigravity's shim passes the shipping rules to the relay, only while the gate is on.
    expect(at(off, "/bin/agy")).not.toContain("command(gh pr")
    const shim = at(on, "/bin/agy")
    for (const rule of shippingRules) expect(shim).toContain(`'${rule}' `)
    expect(shim).toContain(' -- "$@"')
    // The relay gives the gate's events the long limit, only while the gate is on.
    expect(JSON.parse(at(on, "relay.json"))).toEqual(gatedRelayConfig)
    // …and says the gate is on, which the relay's refusals of the rules' shapes lean on.
    expect(gatedRelayConfig.gate).toBe(true)
    expect(Object.keys(relayConfig)).not.toContain("gate")
    expect(gatedRelayConfig.asks.claude).toContain("PreToolUse")
    expect(gatedRelayConfig.asks.codex).toEqual(
      expect.arrayContaining(["PreToolUse", "PermissionRequest"]),
    )
    expect(gatedRelayConfig.asks.opencode).toEqual(
      expect.arrayContaining(["PreToolUse", "PermissionRequest"]),
    )
    expect(relayConfig.asks.opencode).not.toContain("PermissionRequest")
  })
})
