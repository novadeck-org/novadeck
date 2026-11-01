import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"

import { agy } from "@novadeck/harness-agy/index"
import {
  closedAnswer,
  deniedAnswer,
  narrowedAnswers,
  notCommandAnswer,
  runAnswer,
} from "@novadeck/harness-agy/narrow"
import { silentFor } from "@novadeck/harness-core/harness"
import { hookCommand } from "@novadeck/harness-core/hook-command"

import { hookStart, relayConfig, shellFiles, shellPaths } from "../shell/scripts.js"
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
  it("is the relay alone on Windows, with a shim and no shell script", () => {
    // The sh wrapper is POSIX's; asking cmd or PowerShell for one is a mistake.
    for (const dialect of ["cmd", "powershell"] as const)
      expect(() =>
        hookCommand(dialect, {
          agent: "agy",
          event: "PreToolUse",
          narrowed: { answer: closedAnswer, passes: narrowedAnswers },
        }),
      ).toThrow(/relay alone/)
    expect(agy.hook("win32", "PreToolUse")).not.toContain("NOVADECK_NARROW")
    expect(agy.shims?.("win32").map(({ path }) => path)).toEqual(["agy.cmd"])
    const files = shellFiles(shellPaths("/shell", "win32"), "win32")
    expect(files.some(({ path }) => /bin[\\/]agy\.cmd$/.test(path))).toBe(true)
  })

  it("runs the relay directly from cmd's hook command, and only a plain path", () => {
    const direct = [
      String.raw`C:\PROGRA~1\Novadeck\novadeck-relay.exe`,
      "hook",
      "--config",
      "r.json",
    ]
    expect(hookCommand("cmd", { agent: "agy", event: "PreToolUse", direct })).toBe(
      String.raw`C:\PROGRA~1\Novadeck\novadeck-relay.exe hook --config r.json agy PreToolUse`,
    )
    for (const bad of [
      String.raw`C:\Program Files\n.exe`,
      String.raw`"C:\n.exe"`,
      "C:/n.exe",
      String.raw`C:\a&b\n.exe`,
      String.raw`%X%\n.exe`,
      "",
    ])
      expect(() =>
        hookCommand("cmd", { agent: "agy", event: "PreToolUse", direct: [bad, "hook"] }),
      ).toThrow(/can't run/)
    expect(() => hookCommand("cmd", { agent: "agy", event: "PreToolUse", direct: [] })).toThrow()
    for (const dialect of ["sh", "powershell"] as const)
      expect(() =>
        hookCommand(dialect, { agent: "agy", event: "PreToolUse", direct: ["x"] }),
      ).toThrow(/cmd's/)
  })

  it("is the relay's own command line in the shell files on Windows, by paths cmd reads as they are", () => {
    // Windows paths by hand: `join` on the host that runs this test may use other separators.
    const at = (folder: string) => ({
      ...shellPaths("/shell", "win32"),
      relay: `${folder}\\novadeck-relay.exe`,
      relayConfig: `${folder}\\relay.json`,
    })
    const paths = at(String.raw`C:\Users\a\AppData\Novadeck`)
    expect(hookStart(paths, "win32")).toEqual({
      command: paths.relay,
      args: ["hook", "--config", paths.relayConfig],
    })
    expect(hookStart(paths, "linux")).toBeUndefined()
    expect(hookStart(at(String.raw`C:\Users\Ann Lee\Novadeck`), "win32")).toBeUndefined()
    expect(hookStart(at(String.raw`C:\Users\a&b\Novadeck`), "win32")).toBeUndefined()
    // The shell files carry it into Antigravity's hooks, and leave it out without.
    const registered = (shell: ReturnType<typeof at>, start = hookStart(shell, "win32")) => {
      const file = shellFiles(shell, "win32", {
        mcp: { command: "mcp" },
        ...(start && { hook: start }),
      }).find(({ path }) => /agy.*hooks\.json$/.test(path.replaceAll("\\", "/")))
      return Object.keys((JSON.parse(file?.content ?? "{}") as { novadeck: object }).novadeck)
    }
    expect(registered(paths)).toContain("PreToolUse")
    expect(registered(at(String.raw`C:\Ann Lee`))).not.toContain("PreToolUse")
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

  it("lets the runner say nothing but the four answers the wrapper passes", () => {
    const { narrowed: answers } = agy.messaging.permission
    const said = [answers?.run, answers?.notCommand, answers?.closed, answers?.denied]
    expect(said.map((line) => line?.trimEnd())).toEqual([
      runAnswer,
      notCommandAnswer,
      closedAnswer,
      deniedAnswer,
    ])
    for (const line of said) expect(narrowedAnswers).toContain(line?.trimEnd())
    expect(new Set(narrowedAnswers).size).toBe(4)
  })

  it("names the same four answers as the relay's own constants", () => {
    const rust = readFileSync(new URL("../../../relay/src/hook.rs", import.meta.url), "utf8")
    const constants = [...rust.matchAll(/^const [A-Z_]+: &str = "((?:[^"\\]|\\.)*)";$/gm)].map(
      (found) => found[1]!.replaceAll('\\"', '"'),
    )
    expect(constants.toSorted()).toEqual([...narrowedAnswers].toSorted())
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

describe("Antigravity's launch shim on Windows", () => {
  const script = agy.shims?.("win32")[0]?.content ?? ""

  it("reads the terminal's settings beside the shim, and passes them with the mark", () => {
    expect(agy.shims?.("win32")[0]?.path).toBe("agy.cmd")
    expect(script).toContain("rem Novadeck shim for agy.")
    expect(script).toContain(
      String.raw`set "novadeck_settings=%~dp0..\narrow\%NOVADECK_TERMINAL_ID%.json"`,
    )
    expect(script).toContain(String.raw`"%novadeck_real%" --settings "%novadeck_settings%" %*`)
    // The mark is dropped first and set only for the narrowed launch, locally.
    expect(script.indexOf("setlocal")).toBeLessThan(script.indexOf('set "NOVADECK_NARROW="'))
    expect(script.indexOf('set "NOVADECK_NARROW="')).toBeLessThan(
      script.indexOf('set "NOVADECK_NARROW=1"'),
    )
    // A terminal id of anything but plain characters is no file name.
    expect(script).toContain("[A-Za-z0-9_-][A-Za-z0-9_-]*")
    // Its other commands, as the first word that is no option, run as they are.
    for (const other of ["plugin", "models", "mcp", "update"]) expect(script).toContain(other)
    expect(script).toContain('echo " %NOVADECK_SHIMS% " | findstr /c:" agy "')
  })

  /** Runs the shim as the shell does, with a stand-in agy that prints its arguments and mark. */
  const shim = (
    folder: string,
    args: readonly string[],
    { settings = true, env = {} }: { settings?: boolean; env?: NodeJS.ProcessEnv } = {},
  ) => {
    const bin = join(folder, "shell", "bin")
    const real = join(folder, "real")
    mkdirSync(bin, { recursive: true })
    mkdirSync(real, { recursive: true })
    mkdirSync(join(folder, "shell", "narrow"), { recursive: true })
    writeFileSync(join(bin, "agy.cmd"), script)
    const recorder = join(folder, "record.cjs")
    writeFileSync(
      recorder,
      "console.log(JSON.stringify({ args: process.argv.slice(2), narrow: process.env.NOVADECK_NARROW ?? null }))",
    )
    writeFileSync(join(real, "agy.cmd"), `@"${process.execPath}" "${recorder}" %*\r\n`)
    const file = join(folder, "shell", "narrow", "t-1.json")
    if (settings) writeFileSync(file, '{"permissions":{"allow":["command(git)"]}}\n')
    const ran = spawnSync(
      process.env.COMSPEC ?? "cmd.exe",
      ["/d", "/c", join(bin, "agy.cmd"), ...args],
      {
        env: {
          ...process.env,
          PATH: [bin, real, process.env.PATH].join(";"),
          NOVADECK_TERMINAL_ID: "t-1",
          NOVADECK_SHIMS: "agy",
          ...env,
        },
        encoding: "utf8",
      },
    )
    return {
      status: ran.status,
      ...(JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "null") as {
        args: string[]
        narrow: string | null
      }),
      file,
    }
  }
  const folder = (resources: { defer: (undo: () => void) => void }) => {
    const made = mkdtempSync(join(tmpdir(), "novadeck-agy-cmd-shim-"))
    resources.defer(() => rmSync(made, { recursive: true, force: true }))
    return made
  }

  it.runIf(!posix)(
    "passes the settings and the mark where the runner wrote them",
    ({ resources }) => {
      const ran = shim(folder(resources), ["--conversation", "abc", "a b"])
      expect(ran.narrow).toBe("1")
      // The shim names the file through its own `bin\..`, which is the same file.
      expect(ran.args.map((arg) => (arg === ran.args[1] ? normalize(arg) : arg))).toEqual([
        "--settings",
        normalize(ran.file),
        "--conversation",
        "abc",
        "a b",
      ])
    },
  )

  it.runIf(!posix)(
    "runs unchanged without settings, outside Novadeck, and for Antigravity's other commands",
    ({ resources }) => {
      const given = folder(resources)
      const plain = (args: string[]) => ({ args, narrow: null })
      expect(shim(given, ["x"], { settings: false })).toMatchObject(plain(["x"]))
      expect(shim(given, ["plugin", "list"])).toMatchObject(plain(["plugin", "list"]))
      expect(shim(given, ["--verbose", "models"])).toMatchObject(plain(["--verbose", "models"]))
      expect(shim(given, ["x"], { env: { NOVADECK_TERMINAL_ID: "" } })).toMatchObject(plain(["x"]))
      expect(shim(given, ["x"], { env: { NOVADECK_SHIMS: "codex" } })).toMatchObject(plain(["x"]))
    },
  )

  it.runIf(!posix)(
    "drops a mark it was given, and refuses a terminal id that names another path",
    ({ resources }) => {
      const given = folder(resources)
      expect(
        shim(given, ["x"], { settings: false, env: { NOVADECK_NARROW: "1" } }).narrow,
      ).toBeNull()
      for (const id of ["..\\..\\elsewhere", "t-1&echo", "a b"])
        expect(shim(given, ["x"], { env: { NOVADECK_TERMINAL_ID: id } })).toMatchObject({
          args: ["x"],
          narrow: null,
        })
    },
  )
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
