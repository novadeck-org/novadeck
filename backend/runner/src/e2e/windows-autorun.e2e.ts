// WINDOWS, CI'S QUIRKS JOB FOR ANTIGRAVITY: Novadeck's messaging under a cmd AutoRun that
// prints. Antigravity runs its hooks as `cmd /c <command>` through the `cmd` it finds on PATH,
// without `/d`, so the person's AutoRun runs first and what it prints stands before the
// hook's JSON. Where cmd prints, Novadeck puts its own `cmd.exe` pass-through (novadeck-cmd.exe,
// backend/relay) first on PATH for Antigravity in its terminals; it adds `/d` to Novadeck's own
// hook commands alone (docs/agent-messaging.md, "Antigravity on Windows").
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { onTestFinished } from "vitest"

import type { AgentSetup } from "./agents/agent.js"
import { agy } from "./agents/agy.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { delivered, own, sends, sent, start } from "./scenarios.js"

const windows = process.platform === "win32" && supported && process.env.GITHUB_ACTIONS === "true"

const autoRunKey = "HKCU\\Software\\Microsoft\\Command Processor"
const reg = (...args: string[]) => spawnSync("reg.exe", args, { encoding: "utf8" })

/**
 * Makes cmd print a marker before every command it runs, and returns what puts the registry
 * back. It changes the runner's own registry, which no test may on a developer's machine:
 * only CI's runner.
 */
const printingAutoRun = (): (() => void) => {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw new Error("an AutoRun is set on CI's runner only")
  const was = reg("query", autoRunKey, "/v", "AutoRun")
  const previous =
    was.status === 0 ? /AutoRun\s+REG_\w+\s+(.*)$/m.exec(was.stdout)?.[1]?.trim() : undefined
  const restore = () => {
    if (previous === undefined) reg("delete", autoRunKey, "/v", "AutoRun", "/f")
    else reg("add", autoRunKey, "/v", "AutoRun", "/t", "REG_SZ", "/d", previous, "/f")
  }
  const set = reg(
    "add",
    autoRunKey,
    "/v",
    "AutoRun",
    "/t",
    "REG_SZ",
    "/d",
    "echo novadeck-ci: an AutoRun printed this",
    "/f",
  )
  if (set.status !== 0) throw new Error(`AutoRun not set: ${set.stderr}`)
  const printed = spawnSync(process.env.COMSPEC || "cmd.exe", ["/c", "rem"], { encoding: "utf8" })
  if (!printed.stdout.includes("an AutoRun printed this")) {
    restore()
    throw new Error(`cmd printed nothing under the AutoRun: ${printed.stdout}`)
  }
  return restore
}

/** The file Novadeck's cmd.exe pass-through appends the command line it passed on to. */
const logs = new Map<string, string>()

/** Sets the printing AutoRun before the runner starts, and has the pass-through log its runs. */
const underAutoRun = (setup: AgentSetup): AgentSetup => ({
  ...setup,
  prepare: async (sandbox, model, installed, seed) => {
    const env = await setup.prepare(sandbox, model, installed, seed)
    const folder = mkdtempSync(join(tmpdir(), "ndc-"))
    const log = join(folder, "cmd-passed-on.log")
    logs.set(sandbox.root, log)
    onTestFinished(() => {
      logs.delete(sandbox.root)
      rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })
    onTestFinished(printingAutoRun())
    return { ...env, NOVADECK_CMD_LOG: log }
  },
})

// A command line of the pass-through's log that is one of Novadeck's own hooks, as
// novadeck-cmd.rs tells them.
const isNovadeckHook = (entry: string): boolean => /if defined novadeck_hook/i.test(entry)

describe.runIf(windows)("Antigravity on Windows under a printing AutoRun", () => {
  const it = e2e(underAutoRun(agy))

  it("delivers a message between two agents, through Novadeck's cmd.exe pass-through", async ({
    e2e: run,
  }) => {
    run.model.use(
      sends("Ask fox for its colour", "fox", "What is your colour?"),
      own((call) => (sent(call, "fox") ? { text: "Asked." } : undefined)),
      own((call) => (delivered(call, "moth") ? { text: "Mine is teal." } : undefined)),
    )
    const first = await start(run, agy)
    await start(run, agy)
    await first.submit("Ask fox for its colour")
    await run.model.waitFor((call) => delivered(call, "moth"), { timeoutMs: 45_000 })

    const log = logs.get(run.sandbox.root)!
    const passed = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []
    const hooks = passed.filter(isNovadeckHook)
    expect(hooks.length, "Novadeck's hooks went through the pass-through").toBeGreaterThan(0)
    expect(
      hooks.every((one) => one.startsWith("/d ")),
      "every Novadeck hook got /d",
    ).toBe(true)
    // The agent's own commands keep the person's AutoRun.
    expect(
      passed.filter((one) => !isNovadeckHook(one)).some((one) => one.startsWith("/d ")),
      "no other cmd got /d",
    ).toBe(false)
  }, 240_000)
})
