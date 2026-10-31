import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { agy } from "@novadeck/harness-agy/index"
import {
  closedAnswer,
  narrowedAnswers,
  notCommandAnswer,
  runAnswer,
} from "@novadeck/harness-agy/narrow"
import { silentFor } from "@novadeck/harness-core/harness"
import { hookCommand } from "@novadeck/harness-core/hook-command"

import { relayConfig, shellFiles, shellPaths } from "../shell/scripts.js"
import { describe, expect, it } from "../test.js"

const posix = process.platform !== "win32"
const closed = `${closedAnswer}\n`

/** Antigravity's PreToolUse hook command, as its plugin registers it on Linux and macOS. */
const command = agy.hook("linux", "PreToolUse")

/** Runs a hook command as Antigravity does, in sh, with a launcher that prints `script`. */
const hook = (
  folder: string,
  script: string | undefined,
  env: NodeJS.ProcessEnv = {},
  hookCommandLine = command,
) => {
  const launcher = join(folder, "hook")
  if (script !== undefined) {
    writeFileSync(launcher, `#!/bin/sh\n${script}\n`)
    chmodSync(launcher, 0o755)
  }
  const ran = spawnSync("sh", ["-c", hookCommandLine], {
    env: {
      PATH: process.env.PATH,
      ...(script !== undefined && { NOVADECK_HOOK: launcher }),
      ...env,
    },
    encoding: "utf8",
    input: "{}",
  })
  return { status: ran.status, stdout: ran.stdout }
}

const narrowed = { NOVADECK_NARROW: "1" }
const printf = (text: string) => `printf '%s\\n' '${text}'`

describe.runIf(posix)("Antigravity's PreToolUse command in a narrowed terminal", () => {
  it("passes on only the three answers Novadeck gives, a line end allowed", ({ resources }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-narrowed-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    for (const answer of narrowedAnswers) {
      expect(hook(folder, printf(answer), narrowed)).toEqual({ status: 0, stdout: `${answer}\n` })
      expect(hook(folder, `printf '%s' '${answer}'`, narrowed)).toEqual({
        status: 0,
        stdout: `${answer}\n`,
      })
    }
  })

  it("prints force_ask for anything else the launcher prints", ({ resources }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-narrowed-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const others = [
      printf('{"decision":"ask"}'),
      printf('{"decision":"allow"}'),
      printf('{"decision":"deny"}'),
      printf("{}"),
      printf("oops"),
      printf(`${runAnswer} `),
      printf(`${runAnswer}${runAnswer}`),
      printf(`${runAnswer}\n${closedAnswer}`),
      printf('{"decision":"ask","reason":"x"}'),
      "true",
      "exit 0",
      "printf ''",
      "printf '\\n\\n'",
    ]
    for (const script of others)
      expect(hook(folder, script, narrowed), script).toEqual({ status: 0, stdout: closed })
  })

  it("prints force_ask when the launcher fails, even after a valid answer", ({ resources }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-narrowed-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    expect(hook(folder, "exit 1", narrowed)).toEqual({ status: 0, stdout: closed })
    expect(hook(folder, `${printf(runAnswer)}; exit 1`, narrowed)).toEqual({
      status: 0,
      stdout: closed,
    })
    expect(hook(folder, `${printf(runAnswer)}; exit 126`, narrowed)).toEqual({
      status: 0,
      stdout: closed,
    })
  })

  it("prints force_ask where the launcher is unset, empty or gone", ({ resources }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-narrowed-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    expect(hook(folder, undefined, narrowed)).toEqual({ status: 0, stdout: closed })
    expect(hook(folder, undefined, { ...narrowed, NOVADECK_HOOK: "" })).toEqual({
      status: 0,
      stdout: closed,
    })
    expect(hook(folder, undefined, { ...narrowed, NOVADECK_HOOK: join(folder, "gone") })).toEqual({
      status: 0,
      stdout: closed,
    })
  })

  it("answers as it always did in a terminal that isn't narrowed", ({ resources }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-narrowed-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    // The launcher's answer as it is, and "ask" where it is gone, as the harness needs.
    expect(hook(folder, printf('{"decision":"ask"}'))).toEqual({
      status: 0,
      stdout: '{"decision":"ask"}\n',
    })
    expect(hook(folder, "true")).toEqual({ status: 0, stdout: "" })
    expect(hook(folder, undefined)).toEqual({ status: 0, stdout: '{"decision":"ask"}\n' })
    expect(hook(folder, undefined, { NOVADECK_NARROW: "" })).toEqual({
      status: 0,
      stdout: '{"decision":"ask"}\n',
    })
  })

  it("is the command of PreToolUse alone, and of no other event", () => {
    expect(command).toContain("NOVADECK_NARROW")
    for (const event of ["PreInvocation", "Stop", "PostToolUse"])
      expect(agy.hook("linux", event)).not.toContain("NOVADECK_NARROW")
  })
})

describe("a narrowed hook command", () => {
  it("is never given on Windows", () => {
    expect(agy.hook("win32", "PreToolUse")).not.toContain("NOVADECK_NARROW")
    expect(agy.shims?.("win32")).toEqual([])
    expect(() =>
      hookCommand("cmd", {
        agent: "agy",
        event: "PreToolUse",
        narrowed: { answer: closedAnswer, passes: narrowedAnswers },
      }),
    ).toThrow(/never on Windows/)
    expect(() =>
      hookCommand("powershell", {
        agent: "agy",
        event: "PreToolUse",
        narrowed: { answer: closedAnswer, passes: narrowedAnswers },
      }),
    ).toThrow(/never on Windows/)
    const files = shellFiles(shellPaths("/shell", "win32"), "win32")
    expect(files.some(({ path }) => path.endsWith("narrow") || path.includes("agy.cmd"))).toBe(
      false,
    )
    expect(files.some(({ path }) => /bin[\\/]agy/.test(path))).toBe(false)
  })

  it("is registered in Antigravity's hooks for PreToolUse on Linux and macOS", () => {
    const hooks = agy
      .files("linux", { mcp: { command: "mcp" } })
      .find(({ path }) => path === "hooks.json")!.content
    const pre = JSON.parse(hooks).novadeck.PreToolUse[0] as {
      matcher: string
      hooks: { command: string }[]
    }
    expect(pre.matcher).toBe("*")
    expect(pre.hooks).toHaveLength(1)
    expect(pre.hooks[0]?.command).toBe(command)
  })
})

describe("every answer path of a narrowed Antigravity PreToolUse", () => {
  // B3 of the design: the hook command's shell fallback and its wrapper (run above), the
  // relay's fallback and timeout (the relay's own tests), and the runner's silent answers.
  it("prints force_ask where the runner has nothing to say", () => {
    const { messaging } = agy
    expect(silentFor(messaging, "PreToolUse", true)).toBe(closed)
    // Every runner path that cannot decide takes this one: the report queue's failure and
    // unbound answers, the endpoint's timeout and failure (see the endpoint's tests).
    expect(messaging.narrowed?.PreToolUse).toBe(closed)
    // Only that event of a narrowed terminal; every other answers as it did.
    expect(silentFor(messaging, "Stop", true)).toBe("{}\n")
    expect(silentFor(messaging, "PreToolUse", false)).toBe('{"decision":"ask"}\n')
  })

  it("lets the runner say nothing but the three answers the wrapper passes", () => {
    const { narrowed: answers } = agy.messaging.permission
    const said = [answers?.run, answers?.notCommand, answers?.closed]
    expect(said.map((line) => line?.trimEnd())).toEqual([runAnswer, notCommandAnswer, closedAnswer])
    for (const line of said) expect(narrowedAnswers).toContain(line?.trimEnd())
    expect(new Set(narrowedAnswers).size).toBe(3)
  })

  it("leaves the relay's fallback to the relay, which closes it itself", () => {
    // The relay prints force_ask by its own code in a narrowed terminal, whatever relay.json
    // says (backend/relay/src/hook.rs); this only pins that relay.json names the event.
    expect(relayConfig.answered.agy).toEqual(["PreToolUse"])
    expect(relayConfig.env).toContain("NOVADECK_NARROW")
    expect(relayConfig.fallbacks.agy?.PreToolUse).toBe('{"decision":"ask"}')
  })
})

describe.runIf(posix)("Antigravity's launch shim", () => {
  const script = agy.shims?.("linux")[0]?.content ?? ""

  /** Runs the shim as the shell does, with a stand-in agy that prints its arguments and env. */
  const shim = (
    folder: string,
    args: readonly string[],
    { settings, env = {} }: { settings?: boolean; env?: NodeJS.ProcessEnv } = {},
  ) => {
    const bin = join(folder, "shell", "bin")
    const real = join(folder, "real")
    mkdirSync(bin, { recursive: true })
    mkdirSync(real, { recursive: true })
    mkdirSync(join(folder, "shell", "narrow"), { recursive: true })
    writeFileSync(join(bin, "agy"), script, { mode: 0o755 })
    writeFileSync(
      join(real, "agy"),
      '#!/bin/sh\necho "args:$*"\necho "narrow:${NOVADECK_NARROW:-unset}"\n',
      { mode: 0o755 },
    )
    if (settings)
      writeFileSync(
        join(folder, "shell", "narrow", "t-1.json"),
        '{"permissions":{"allow":["command(git)"]}}\n',
      )
    const ran = spawnSync(join(bin, "agy"), [...args], {
      env: {
        PATH: `${bin}:${real}:/usr/bin:/bin`,
        NOVADECK_TERMINAL_ID: "t-1",
        NOVADECK_SHIMS: "agy",
        ...env,
      },
      encoding: "utf8",
    })
    return { status: ran.status, lines: ran.stdout.trim().split("\n") }
  }
  const settings = (folder: string) => join(folder, "shell", "narrow", "t-1.json")

  it("passes the terminal's launch settings and narrows its hooks where the runner wrote them", ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-agy-shim-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const ran = shim(folder, ["--conversation", "abc"], { settings: true })
    expect(ran.lines[1]).toBe("narrow:1")
    expect(ran.lines[0]).toMatch(/^args:--settings \S+\/narrow\/t-1\.json --conversation abc$/)
    expect(readFileSync(settings(folder), "utf8")).toContain("command(git)")
  })

  it("runs unchanged without settings, outside Novadeck and for Antigravity's other commands", ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-agy-shim-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    expect(shim(folder, ["--conversation", "abc"]).lines).toEqual([
      "args:--conversation abc",
      "narrow:unset",
    ])
    const plain = ["args:plugin list", "narrow:unset"]
    expect(shim(folder, ["plugin", "list"], { settings: true }).lines).toEqual(plain)
    expect(shim(folder, ["--verbose", "models"], { settings: true }).lines).toEqual([
      "args:--verbose models",
      "narrow:unset",
    ])
    // Not in a Novadeck terminal, or not while Antigravity is connected.
    expect(
      shim(folder, ["plugin", "list"], { settings: true, env: { NOVADECK_TERMINAL_ID: "" } }).lines,
    ).toEqual(plain)
    expect(shim(folder, ["x"], { settings: true, env: { NOVADECK_SHIMS: "codex" } }).lines).toEqual(
      ["args:x", "narrow:unset"],
    )
  })

  it("drops a NOVADECK_NARROW it was given, and refuses a terminal id that names another path", ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-agy-shim-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    expect(shim(folder, ["x"], { env: { NOVADECK_NARROW: "1" } }).lines).toEqual([
      "args:x",
      "narrow:unset",
    ])
    writeFileSync(join(folder, "elsewhere.json"), "{}")
    mkdirSync(join(folder, "shell", "narrow"), { recursive: true })
    expect(shim(folder, ["x"], { env: { NOVADECK_TERMINAL_ID: "../../elsewhere" } }).lines).toEqual(
      ["args:x", "narrow:unset"],
    )
  })
})

describe("Antigravity's launch grant gate", () => {
  it("takes the launch settings from 1.4.10 on, and gives none to an older or unknown version", () => {
    const takes = agy.takesLaunchGrants!
    for (const output of ["1.4.10", "agy 1.4.10\n", "1.4.11", "1.5.0", "v2.0.0 (build 3)"])
      expect(takes(output), output).toBe(true)
    for (const output of ["1.4.3", "1.4.9\n", "0.9.99", "", "agy dev", "error: no such flag"])
      expect(takes(output), output).toBe(false)
  })
})
