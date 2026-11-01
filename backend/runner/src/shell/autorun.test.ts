import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AutoRunState } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import type { AutoRunRead, Scope, Swap } from "./autorun-relay.js"
import { encodeValue } from "./autorun-value.js"
import { AutoRun, type AutoRunHost, type Printing, runsClean } from "./autorun.js"
import { installAgyPlugin, installShellFiles } from "./install.js"

const scope = (text: string, type: "sz" | "expand" | "other" = "sz"): Scope => ({
  found: "value",
  type,
  encoded: encodeValue(text),
})
const absent: Scope = { found: "absent" }

const printing = "chcp 65001"
const wrapped = "(chcp 65001) >nul 2>&1"

// The registry, relay, cmd and terminals of a Windows machine, as fakes the test steers.
const machine = (over: { user?: Scope; machine?: Scope } = {}) => {
  const registry: { user: Scope; machine: Scope } = {
    user: over.user ?? scope(printing),
    machine: over.machine ?? absent,
  }
  const calls: string[] = []
  const swaps: { kind: string; expected: string; next: string }[] = []
  const fake = {
    registry,
    calls,
    swaps,
    // What a value prints alone, and what the real cmd prints with every AutoRun.
    isolation: (text: string): Printing => (text.includes(">nul") ? "clean" : "prints"),
    recheck: (): "prints" | "slow" | undefined =>
      registry.machine.found === "value" ? "prints" : undefined,
    swap: "ok" as Swap,
    // The result of the nth write, where one is to differ from `swap`.
    swapAt: undefined as ((count: number) => Swap | undefined) | undefined,
    running: [] as string[],
    pluginFails: false,
    // A write by somebody else between the click and the write.
    changeBeforeSwap: undefined as (() => void) | undefined,
  }
  const host: AutoRunHost = {
    platform: "win32",
    read: () => Promise.resolve({ ...registry } satisfies AutoRunRead),
    swap: (kind, expected, next) => {
      swaps.push({ kind, expected, next })
      fake.changeBeforeSwap?.()
      fake.changeBeforeSwap = undefined
      const forced = fake.swapAt?.(swaps.length) ?? fake.swap
      if (forced !== "ok") return Promise.resolve(forced)
      if (registry.user.found !== "value" || registry.user.encoded !== expected)
        return Promise.resolve("changed")
      registry.user = { found: "value", type: kind, encoded: next }
      return Promise.resolve("ok")
    },
    isolated: (text) => Promise.resolve(fake.isolation(text)),
    recheck: () => Promise.resolve(fake.recheck()),
    running: () => fake.running,
    writePlugin: (flag) => {
      calls.push(`plugin ${flag ? "printing" : "quiet"}`)
      return fake.pluginFails ? Promise.reject(new Error("disk")) : Promise.resolve()
    },
    refresh: () => {
      calls.push("refresh")
      return Promise.resolve(true)
    },
    announce: () => void calls.push("announce"),
  }
  return { fake, host }
}

const stateOf = async (autorun: AutoRun): Promise<AutoRunState> => {
  const watch = autorun.watch()
  const first = await watch.next()
  await watch.return(undefined)
  return first.value as AutoRunState
}

// A runner started, whose first check of cmd found `check`: it prints, is slow, or is quiet.
const started = async (
  over: Parameters<typeof machine>[0] = {},
  check: "prints" | "slow" | "quiet" = "prints",
) => {
  const { fake, host } = machine(over)
  const autorun = new AutoRun(host)
  await autorun.started(check === "quiet" ? undefined : check)
  return { fake, autorun }
}

describe("the AutoRun state", () => {
  it("is none off Windows and where the start found cmd quiet or slow", async () => {
    const { host } = machine()
    const linux = new AutoRun({ ...host, platform: "linux" })
    await linux.started("prints")
    expect(await stateOf(linux)).toEqual({ state: "none", outcome: null })
    const quiet = await started({}, "quiet")
    const slow = await started({}, "slow")
    expect(await stateOf(quiet.autorun)).toEqual({ state: "none", outcome: null })
    expect(await stateOf(slow.autorun)).toEqual({ state: "none", outcome: null })
  })

  it("is an offer when the original prints alone and the rewrite does not, with the value verbatim and the machine's", async () => {
    const { autorun } = await started({ machine: scope("chcp 437") })
    expect(await stateOf(autorun)).toEqual({
      state: "offer",
      current: printing,
      next: wrapped,
      machine: "chcp 437",
      outcome: null,
    })
  })

  it("says whether cmd prints as the start found it, and only for a prints or a slow check", async () => {
    const { host } = machine()
    const autorun = new AutoRun(host)
    expect(autorun.printing()).toBe(false)
    await autorun.started("slow")
    expect(autorun.printing()).toBe(true)
    await autorun.started(undefined)
    expect(autorun.printing()).toBe(false)
  })

  it("is manual, saying why, wherever Novadeck can't make the change", async () => {
    const manual = async (
      over: Parameters<typeof machine>[0],
      tweak?: (f: ReturnType<typeof machine>["fake"]) => void,
    ) => {
      const { fake, host } = machine(over)
      tweak?.(fake)
      const autorun = new AutoRun(host)
      await autorun.started("prints")
      return stateOf(autorun)
    }
    // The printing value is in HKLM: HKCU holds none, or one that prints nothing alone.
    expect(await manual({ user: absent, machine: scope(printing) })).toMatchObject({
      state: "manual",
      reason: "machine",
      machine: printing,
      suggested: wrapped,
    })
    expect(
      await manual({ user: scope("echo quiet"), machine: scope(printing) }, (f) => {
        f.isolation = () => "clean"
      }),
    ).toMatchObject({ state: "manual", reason: "machine", current: "echo quiet" })
    // silenced() refuses HKCU's value and names the rule.
    expect(await manual({ user: scope("title Dev (x64)") })).toMatchObject({
      state: "manual",
      reason: "refused",
      current: "title Dev (x64)",
      rule: expect.stringContaining("parenthesis"),
    })
    // Not in normal form, a type other than sz and expand, or not readable.
    expect(await manual({ user: scope(printing, "other") })).toMatchObject({
      state: "manual",
      reason: "form",
    })
    expect(
      await manual({
        user: { found: "value", type: "sz", encoded: Buffer.from("ab").toString("base64") },
      }),
    ).toMatchObject({ state: "manual", reason: "form" })
    expect(await manual({ user: { found: "unreadable" } })).toMatchObject({
      state: "manual",
      reason: "form",
    })
    // HKCU's value prints nothing alone: the output is from elsewhere.
    expect(await manual({}, (f) => (f.isolation = () => "clean"))).toMatchObject({
      state: "manual",
      reason: "quiet",
    })
    // Whether it prints could not be told.
    expect(await manual({}, (f) => (f.isolation = () => "slow"))).toMatchObject({
      state: "manual",
      reason: "unchecked",
    })
    // The rewrite would print still.
    expect(await manual({}, (f) => (f.isolation = () => "prints"))).toMatchObject({
      state: "manual",
      reason: "refused",
    })
  })

  it("offers nothing for a blank value or none, and nothing when nothing holds one", async () => {
    expect(await stateOf((await started({ user: scope("   ") })).autorun)).toMatchObject({
      state: "none",
    })
    expect(await stateOf((await started({ user: absent })).autorun)).toMatchObject({
      state: "none",
    })
  })

  it("is silenced whenever HKCU is exactly the wrapper, whoever wrote it, and with the start's check quiet", async () => {
    const { autorun } = await started({ user: scope(wrapped) }, "quiet")
    expect(await stateOf(autorun)).toEqual({
      state: "silenced",
      current: wrapped,
      restores: printing,
      machine: null,
      outcome: null,
    })
    // A wrapper round something silenced() refuses is not ours.
    const other = await started({ user: scope("(if 1==1 (echo a)) >nul 2>&1") }, "quiet")
    expect(await stateOf(other.autorun)).toMatchObject({ state: "none" })
  })

  it("hides an offer or a manual step on Not now, until the next start", async () => {
    const { autorun } = await started()
    await autorun.dismiss()
    expect(await stateOf(autorun)).toEqual({ state: "none", outcome: null })
    await autorun.started("prints")
    expect(await stateOf(autorun)).toMatchObject({ state: "offer" })
  })

  it("streams the state, then each change", async () => {
    const { autorun } = await started()
    const watch = autorun.watch()
    expect(((await watch.next()).value as AutoRunState).state).toBe("offer")
    const next = watch.next()
    await autorun.silence(wrapped)
    expect(((await next).value as AutoRunState).state).toBe("silenced")
    await watch.return(undefined)
  })
})

describe("silencing", () => {
  it("writes exactly the new value, rechecks the real cmd, and then renders, installs and announces", async () => {
    const { fake, autorun } = await started()
    await autorun.silence(wrapped)
    expect(fake.swaps).toEqual([
      { kind: "sz", expected: encodeValue(printing), next: encodeValue(wrapped) },
    ])
    expect(fake.registry.user).toEqual(scope(wrapped))
    expect(autorun.printing()).toBe(false)
    expect(fake.calls).toEqual(["plugin quiet", "refresh", "announce"])
    expect(await stateOf(autorun)).toMatchObject({
      state: "silenced",
      current: wrapped,
      restores: printing,
      outcome: { kind: "applied-clean", waiting: [] },
    })
  })

  it("says which Antigravity terminals still run, as their plugin waits for them", async () => {
    const { fake, autorun } = await started()
    fake.running = ["fox"]
    await autorun.silence(wrapped)
    expect(await stateOf(autorun)).toMatchObject({
      outcome: { kind: "applied-clean", waiting: ["fox"] },
    })
  })

  it("keeps the type it read", async () => {
    const { fake, autorun } = await started({ user: scope(printing, "expand") })
    await autorun.silence(wrapped)
    expect(fake.registry.user).toEqual(scope(wrapped, "expand"))
    expect(fake.swaps[0]?.kind).toBe("expand")
  })

  it("refuses with a conflict, writing nothing, for a value that is not the one shown", async () => {
    const { fake, autorun } = await started()
    await autorun.silence("(something else) >nul 2>&1")
    expect(fake.swaps).toEqual([])
    expect(await stateOf(autorun)).toMatchObject({ state: "offer", outcome: { kind: "conflict" } })
    // The registry changed since the card showed it.
    fake.registry.user = scope("chcp 437")
    await autorun.silence(wrapped)
    expect(fake.swaps).toEqual([])
  })

  it("refuses to write where the start found cmd quiet, slow, or the person said not now", async () => {
    const quiet = await started({}, "quiet")
    const slow = await started({}, "slow")
    await quiet.autorun.silence(wrapped)
    await slow.autorun.silence(wrapped)
    expect(quiet.fake.swaps).toEqual([])
    expect(slow.fake.swaps).toEqual([])
  })

  it("is a conflict when the compare-and-set finds another value, and a failure when it fails", async () => {
    const changed = await started()
    changed.fake.swap = "changed"
    await changed.autorun.silence(wrapped)
    expect(await stateOf(changed.autorun)).toMatchObject({ outcome: { kind: "conflict" } })
    const failing = await started()
    failing.fake.swap = "failed"
    await failing.autorun.silence(wrapped)
    expect(await stateOf(failing.autorun)).toMatchObject({ outcome: { kind: "failed" } })
    const unverified = await started()
    unverified.fake.swap = "unverified"
    await unverified.autorun.silence(wrapped)
    expect(await stateOf(unverified.autorun)).toMatchObject({ outcome: { kind: "failed" } })
    expect(unverified.autorun.printing()).toBe(true)
    expect(unverified.fake.calls).toEqual([])
  })

  it("is a conflict when somebody else wrote between the read and the write", async () => {
    const { fake, autorun } = await started()
    fake.changeBeforeSwap = () => (fake.registry.user = scope("chcp 437"))
    await autorun.silence(wrapped)
    expect(fake.registry.user).toEqual(scope("chcp 437"))
    expect(await stateOf(autorun)).toMatchObject({ outcome: { kind: "conflict" } })
  })

  it("is refused again if the isolation check no longer shows the rewrite works", async () => {
    const { fake, autorun } = await started()
    fake.isolation = (text) => (text === wrapped ? "prints" : "prints")
    await autorun.silence(wrapped)
    expect(fake.swaps).toEqual([])
  })

  it("rolls the change back when cmd still prints and no machine value is to blame", async () => {
    const { fake, autorun } = await started()
    fake.recheck = () => "prints"
    await autorun.silence(wrapped)
    expect(fake.swaps.map(({ expected, next }) => [expected, next])).toEqual([
      [encodeValue(printing), encodeValue(wrapped)],
      [encodeValue(wrapped), encodeValue(printing)],
    ])
    expect(fake.registry.user).toEqual(scope(printing))
    expect(autorun.printing()).toBe(true)
    expect(fake.calls).toEqual([])
    expect(await stateOf(autorun)).toMatchObject({
      state: "offer",
      outcome: { kind: "rolled-back" },
    })
  })

  it("counts a slow recheck as not clean", async () => {
    const { fake, autorun } = await started()
    fake.recheck = () => "slow"
    await autorun.silence(wrapped)
    expect(fake.registry.user).toEqual(scope(printing))
  })

  it("keeps the change when the machine's AutoRun holds a value and cmd still prints", async () => {
    const { fake, autorun } = await started({ machine: scope("chcp 437") })
    await autorun.silence(wrapped)
    expect(fake.swaps).toHaveLength(1)
    expect(fake.registry.user).toEqual(scope(wrapped))
    expect(autorun.printing()).toBe(true)
    expect(fake.calls).toEqual([])
    expect(await stateOf(autorun)).toMatchObject({
      state: "silenced",
      machine: "chcp 437",
      outcome: { kind: "applied-still-prints-hklm" },
    })
  })

  it("says so when it could not put the value back after a recheck that was not clean", async () => {
    const { fake, autorun } = await started()
    fake.recheck = () => "prints"
    fake.swapAt = (count) => (count === 2 ? "failed" : undefined)
    await autorun.silence(wrapped)
    expect(fake.registry.user).toEqual(scope(wrapped))
    expect(await stateOf(autorun)).toMatchObject({
      state: "silenced",
      outcome: { kind: "failed" },
    })
  })

  it("leaves cmd counted as printing, and says so, if the plugin can't be updated", async () => {
    const { fake, autorun } = await started()
    fake.pluginFails = true
    await autorun.silence(wrapped)
    expect(autorun.printing()).toBe(true)
    expect(await stateOf(autorun)).toMatchObject({
      state: "silenced",
      outcome: { kind: "failed" },
    })
  })
})

describe("undoing", () => {
  it("renders the plugin without PreToolUse and installs it before the registry changes, then restores the exact value", async () => {
    const { fake, autorun } = await started({ user: scope(wrapped, "expand") }, "quiet")
    let order: string[] = []
    const record = fake.calls
    const swap = fake.swaps
    await autorun.undo()
    order = [...record]
    expect(order).toEqual(["plugin printing", "refresh", "announce"])
    expect(swap).toEqual([
      { kind: "expand", expected: encodeValue(wrapped), next: encodeValue(printing) },
    ])
    expect(fake.registry.user).toEqual(scope(printing, "expand"))
    expect(autorun.printing()).toBe(true)
    // cmd prints again, so the offer is back.
    expect(await stateOf(autorun)).toMatchObject({
      state: "offer",
      current: printing,
      outcome: { kind: "undone" },
    })
  })

  it("is refused while any Novadeck Antigravity terminal runs, naming them, and changes nothing", async () => {
    const { fake, autorun } = await started({ user: scope(wrapped) }, "quiet")
    fake.running = ["fox", "owl"]
    await autorun.undo()
    expect(fake.swaps).toEqual([])
    expect(fake.calls).toEqual([])
    expect(autorun.printing()).toBe(false)
    expect(await stateOf(autorun)).toMatchObject({
      state: "silenced",
      outcome: { kind: "undo-refused", terminals: ["fox", "owl"] },
    })
  })

  it("only unwraps: a value that is not Novadeck's wrapper is left alone", async () => {
    const { fake, autorun } = await started({ user: scope(printing) }, "quiet")
    await autorun.undo()
    expect(fake.swaps).toEqual([])
    expect(fake.calls).toEqual([])
    // Nor does it write one that the registry changed to after the card.
    fake.registry.user = scope("(if 1==1 (echo a)) >nul 2>&1")
    await autorun.undo()
    expect(fake.swaps).toEqual([])
    // And a wrapper whose compare-and-set loses a race is a conflict, the value untouched.
    fake.registry.user = scope(wrapped)
    fake.changeBeforeSwap = () => (fake.registry.user = scope("(chcp 437) >nul 2>&1"))
    await autorun.undo()
    expect(fake.registry.user).toEqual(scope("(chcp 437) >nul 2>&1"))
  })

  it("puts the plugin back to registering PreToolUse if the unwrap fails while cmd is quiet still", async () => {
    const { fake, autorun } = await started({ user: scope(wrapped) }, "quiet")
    fake.swap = "failed"
    await autorun.undo()
    expect(fake.registry.user).toEqual(scope(wrapped))
    expect(autorun.printing()).toBe(false)
    expect(fake.calls).toEqual([
      "plugin printing",
      "refresh",
      "plugin quiet",
      "refresh",
      "announce",
    ])
  })
})

describe("the AutoRun's plugin rewrite", () => {
  const folder = () => mkdtempSync(join(tmpdir(), "novadeck-autorun-"))
  const options = (directory: string) => {
    const relay = join(directory, "novadeck-relay.exe")
    writeFileSync(relay, "relay")
    return {
      relay,
      cmdShim: relay,
      platform: "win32" as const,
      prints: () => Promise.resolve("prints" as const),
      silenced: () => Promise.resolve(false),
      short: (path: string) => Promise.resolve(path.replaceAll("/", "\\").replace(/^\\/, "C:\\")),
    }
  }

  it("registers PreToolUse again and leaves narrow/ and resume/ as they are", async ({
    resources,
  }) => {
    const directory = folder()
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    const installed = await installShellFiles(join(directory, "shell"), options(directory))
    // This machine's paths can't be the plain ones Windows' hook launcher needs: give it one.
    const shell = {
      ...installed,
      launchers: { ...installed.launchers!, hook: { command: "C:\\r\\relay.exe", args: ["hook"] } },
    }
    expect(shell.cmdPrints).toBe(true)
    expect(shell.cmdCheck).toBe("prints")
    const hooks = join(shell.plugins.agy, "hooks.json")
    expect(readFileSync(hooks, "utf8")).not.toContain("PreToolUse")
    // What a running terminal reads, which a whole install would remove.
    mkdirSync(shell.narrow, { recursive: true })
    writeFileSync(join(shell.narrow, "7.json"), "{}")
    writeFileSync(join(shell.resume, "7"), "agy --conversation x")

    await installAgyPlugin(shell, false, "win32")
    expect(readFileSync(hooks, "utf8")).toContain("PreToolUse")
    expect(existsSync(join(shell.narrow, "7.json"))).toBe(true)
    expect(existsSync(join(shell.resume, "7"))).toBe(true)

    await installAgyPlugin(shell, true, "win32")
    expect(readFileSync(hooks, "utf8")).not.toContain("PreToolUse")
    expect(existsSync(join(shell.narrow, "7.json"))).toBe(true)
  })
})

describe("the check of a value alone", () => {
  it("is clean for a cmd that prints nothing, prints for stdout or stderr, and slow past its time", async () => {
    // A stand-in for cmd that ignores its /d /s /c arguments and runs the value as a script.
    const run = (script: string, timeoutMs = 5_000) =>
      runsClean(script, {
        program: process.execPath,
        timeoutMs,
        args: (each) => ["-e", each],
      })
    await expect(run("")).resolves.toBe("clean")
    await expect(run("process.stdout.write('x')")).resolves.toBe("prints")
    await expect(run("process.stderr.write('x')")).resolves.toBe("prints")
    await expect(run("setTimeout(() => {}, 10_000)", 200)).resolves.toBe("slow")
  })

  it("is slow where cmd does not start", async () => {
    await expect(
      runsClean("x", { program: join(tmpdir(), "no-such-cmd.exe"), args: (each) => [each] }),
    ).resolves.toBe("slow")
  })
})
