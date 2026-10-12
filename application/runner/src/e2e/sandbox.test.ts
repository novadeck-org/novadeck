import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { createSandbox, keychainAsks, keychainGuard, unsuffixedClaudeItem } from "./sandbox.js"

describe("Claude Code's Keychain items", () => {
  it("are the person's own without a folder's suffix, and the sandbox's with one", () => {
    expect(unsuffixedClaudeItem.test("Claude Code-credentials")).toBe(true)
    expect(unsuffixedClaudeItem.test("Claude Code")).toBe(true)
    expect(unsuffixedClaudeItem.test("Claude Code-local-oauth-credentials")).toBe(true)
    expect(unsuffixedClaudeItem.test("Claude Code-credentials-1a2b3c4d")).toBe(false)
    expect(unsuffixedClaudeItem.test("Claude Code-1a2b3c4d")).toBe(false)
    expect(unsuffixedClaudeItem.test("gemini")).toBe(false)
  })
})

// The guard over a stand-in for the system's security, which writes what reached it.
const guarded = (resources: { defer: (cleanup: () => void) => void }) => {
  const folder = mkdtempSync(join(tmpdir(), "novadeck-keychain-"))
  resources.defer(() => rmSync(folder, { recursive: true, force: true }))
  const real = join(folder, "real")
  const reached = join(folder, "reached")
  writeFileSync(real, `#!/bin/sh\n{ printf '%s|' "$@"; printf '\\n'; cat; } > '${reached}'\n`)
  chmodSync(real, 0o755)
  const log = join(folder, "log")
  keychainGuard(folder, log, real)
  const run = (args: readonly string[], input = "") =>
    spawnSync(join(folder, "security"), args, { input }).status
  return {
    run,
    reached: () => (existsSync(reached) ? readFileSync(reached, "utf8") : undefined),
    asked: () => keychainAsks({ keychainLog: log }),
  }
}

describe.skipIf(process.platform === "win32")("the sandbox's security", () => {
  it("refuses the person's own Claude Code item however it is named, passing nothing on", ({
    resources,
  }) => {
    const guard = guarded(resources)

    expect(guard.run(["find-generic-password", "-a", "me", "-s", "Claude Code-credentials"])).toBe(
      44,
    )
    expect(guard.run(["find-generic-password", "-sClaude Code-credentials"])).toBe(44)
    expect(
      guard.run(["-i"], 'add-generic-password -U -a "me" -s "Claude Code-device-keys" -X "00"\n'),
    ).toBe(44)
    expect(guard.reached()).toBeUndefined()
    expect(guard.asked()).toEqual([
      "Claude Code-credentials",
      "Claude Code-credentials",
      "Claude Code-device-keys",
    ])
  })

  it("refuses the person's own item on security -i's input whatever its layout", ({
    resources,
  }) => {
    const guard = guarded(resources)
    const layouts = [
      "add-generic-password -a me -s\t'Claude Code-device-keys' -X 00\n",
      'add-generic-password -s  "Claude Code-credentials" -X 00\n',
      'add-generic-password -s"Claude Code-credentials" -X 00\n',
      "add-generic-password -s Claude\\ Code-credentials -X 00\n",
    ]

    for (const input of layouts) expect(guard.run(["-i"], input)).toBe(44)
    expect(guard.run(["-qi"], 'add-generic-password -s "Claude Code-credentials" -X 00\n')).toBe(44)
    expect(guard.reached()).toBeUndefined()
  })

  it("reads -i only as a global option, never as an option's value", ({ resources }) => {
    const guard = guarded(resources)

    // As `-a -i` would, were it read as interactive: waiting on an input that never ends.
    expect(guard.run(["find-generic-password", "-a", "-i", "-s", "gemini"])).toBe(0)
    expect(guard.reached()).toBe("find-generic-password|-a|-i|-s|gemini|\n")
  })

  it("passes on what the sandbox's Claude Code asks for, its input as it came", ({ resources }) => {
    const guard = guarded(resources)
    const input = 'add-generic-password -U -a "me" -s "Claude Code-credentials-1a2b3c4d" -X "00"\n'

    expect(guard.run(["-i"], input)).toBe(0)
    expect(guard.reached()).toBe(`-i|\n${input}`)
    expect(guard.run(["find-generic-password", "-s", "gemini"])).toBe(0)
    expect(guard.asked()).toEqual(["Claude Code-credentials-1a2b3c4d", "gemini"])
  })
})

describe.runIf(process.platform === "darwin")("the sandbox's security on macOS", () => {
  it("refuses Claude Code the person's own item, passes the rest, and says what was asked", ({
    resources,
  }) => {
    const sandbox = createSandbox({ proxy: "http://127.0.0.1:9", bins: [] })
    resources.defer(() => rmSync(sandbox.root, { recursive: true, force: true }))
    // As Claude Code asks: `security` by name, through the sandbox's PATH.
    const ask = (service: string) =>
      spawnSync("/bin/sh", ["-c", `security find-generic-password -a novadeck -s "${service}"`], {
        env: sandbox.env,
        stdio: "ignore",
      }).status

    expect(ask("Claude Code-credentials")).toBe(44)
    // Passed on to the real one, which holds no such item in any Keychain.
    expect(ask("Claude Code-credentials-1a2b3c4d")).toBe(44)
    expect(ask("novadeck-e2e-nothing")).toBe(44)
    expect(keychainAsks(sandbox)).toEqual([
      "Claude Code-credentials",
      "Claude Code-credentials-1a2b3c4d",
      "novadeck-e2e-nothing",
    ])
  })
})
