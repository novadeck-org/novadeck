import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  commands,
  configPlugin,
  hooksTrusted,
  kept,
  makeCmdShim,
  posixShim,
  valued,
} from "./shim.js"

const posixOnly = process.platform === "win32" ? describe.skip : describe

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "novadeck-opencode-shim-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// A Novadeck shell folder: the shim in bin, the plugin where the runner writes it, and a stand-in
// for the real opencode that says what it was given.
const setup = (folder = root, { plugin = true, reexport = true } = {}) => {
  const shell = join(folder, "shell")
  const plugins = join(shell, "plugins", "opencode")
  mkdirSync(join(shell, "bin"), { recursive: true })
  mkdirSync(join(folder, "real"), { recursive: true })
  if (plugin) {
    mkdirSync(join(plugins, "config", "plugins"), { recursive: true })
    writeFileSync(join(plugins, "novadeck.mjs"), "export const NovadeckPlugin = async () => ({})\n")
    if (reexport) writeFileSync(join(plugins, configPlugin), 'export * from "../../novadeck.mjs"\n')
  }
  const shim = join(shell, "bin", "opencode")
  writeFileSync(shim, posixShim())
  chmodSync(shim, 0o755)
  const real = join(folder, "real", "opencode")
  writeFileSync(
    real,
    `#!/bin/sh
for v in NOVADECK_OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_DIR NOVADECK_OPENCODE_SESSION NOVADECK_OPENCODE_CONTINUE NOVADECK_OPENCODE_FORK; do
  eval "printf 'ENV %s=%s\\n' $v \\"\\\${$v-<unset>}\\""
done
printf 'ARG %s\\n' "$@"
`,
  )
  chmodSync(real, 0o755)
  return { shell, plugins, shim, real: join(folder, "real") }
}

type Ran = { readonly env: Record<string, string>; readonly args: string[] }

const run = (
  place: ReturnType<typeof setup>,
  args: string[],
  env: Record<string, string> = {},
): Ran => {
  const out = execFileSync("sh", [place.shim, ...args], {
    env: { PATH: `${place.real}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  })
  const result: Ran = { env: {}, args: [] }
  for (const line of out.split("\n")) {
    if (line.startsWith("ARG ")) result.args.push(line.slice(4))
    else if (line.startsWith("ENV ")) {
      const at = line.indexOf("=")
      result.env[line.slice(4, at)] = line.slice(at + 1)
    }
  }
  return result
}

const inNovadeck = { NOVADECK_TERMINAL_ID: "t1", NOVADECK_SHIMS: "claude opencode" }

posixOnly("the POSIX shim", () => {
  it("runs the real opencode as it was given, outside a Novadeck terminal", () => {
    const ran = run(setup(), ["-s", "ses_abc"])
    expect(ran.args).toEqual(["-s", "ses_abc"])
    expect(ran.env.OPENCODE_CONFIG_CONTENT).toBe("<unset>")
    expect(ran.env.NOVADECK_OPENCODE_SESSION).toBe("<unset>")
  })

  it("runs it plain where the terminal's shims don't name opencode", () => {
    const ran = run(setup(), ["-c"], { NOVADECK_TERMINAL_ID: "t1", NOVADECK_SHIMS: "claude codex" })
    expect(ran.env).toMatchObject({
      OPENCODE_CONFIG_CONTENT: "<unset>",
      NOVADECK_OPENCODE_CONTINUE: "<unset>",
    })
  })

  it("has opencode load the plugin through OPENCODE_CONFIG_CONTENT, with no file written", () => {
    const place = setup()
    const ran = run(place, ["--model", "p/m"], inNovadeck)
    expect(JSON.parse(ran.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      plugin: [join(place.plugins, "novadeck.mjs")],
    })
    expect(ran.env.OPENCODE_CONFIG_DIR).toBe("<unset>")
    expect(ran.args).toEqual(["--model", "p/m"])
  })

  it("names a plugin whose folder has a space, which opencode loads as a path", () => {
    const folder = join(root, "a b")
    mkdirSync(folder)
    const place = setup(folder)
    const ran = run(place, [], inNovadeck)
    expect(JSON.parse(ran.env.OPENCODE_CONFIG_CONTENT!).plugin).toEqual([
      join(place.plugins, "novadeck.mjs"),
    ])
  })

  it("keeps a person's own OPENCODE_CONFIG_CONTENT, and loads the plugin from a config folder", () => {
    const place = setup()
    const own = '{"model":"p/m"}'
    const ran = run(place, [], { ...inNovadeck, OPENCODE_CONFIG_CONTENT: own })
    expect(ran.env.OPENCODE_CONFIG_CONTENT).toBe(own)
    expect(ran.env.OPENCODE_CONFIG_DIR).toBe(join(place.plugins, "config"))
  })

  it("keeps their own OPENCODE_CONFIG_DIR too, and then loads nothing", () => {
    const place = setup()
    const ran = run(place, [], {
      ...inNovadeck,
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_CONFIG_DIR: "/theirs",
    })
    expect(ran.env).toMatchObject({ OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG_DIR: "/theirs" })
  })

  it("loads nothing where the plugin's file isn't there", () => {
    const ran = run(setup(root, { plugin: false }), [], inNovadeck)
    expect(ran.env).toMatchObject({
      OPENCODE_CONFIG_CONTENT: "<unset>",
      OPENCODE_CONFIG_DIR: "<unset>",
    })
  })

  it("uses the config folder where the plugin's path couldn't sit in JSON", () => {
    const folder = join(root, 'q"uote')
    mkdirSync(folder)
    const place = setup(folder)
    const ran = run(place, [], inNovadeck)
    expect(ran.env.OPENCODE_CONFIG_CONTENT).toBe("<unset>")
    expect(ran.env.OPENCODE_CONFIG_DIR).toBe(join(place.plugins, "config"))
  })

  it("tells the plugin the session, in each way the command line names one", () => {
    const place = setup()
    for (const args of [
      ["-s", "ses_a"],
      ["--session", "ses_a"],
      ["--session=ses_a"],
      ["--model", "p/m", "-s", "ses_a"],
    ])
      expect(run(place, args, inNovadeck).env.NOVADECK_OPENCODE_SESSION).toBe("ses_a")
    expect(run(place, ["-c"], inNovadeck).env).toMatchObject({
      NOVADECK_OPENCODE_CONTINUE: "1",
      NOVADECK_OPENCODE_FORK: "<unset>",
    })
    expect(run(place, ["--continue", "--fork"], inNovadeck).env).toMatchObject({
      NOVADECK_OPENCODE_CONTINUE: "1",
      NOVADECK_OPENCODE_FORK: "1",
    })
  })

  it("takes no session from an option's value, nor from what an outer launch left", () => {
    const place = setup()
    const ran = run(place, ["--prompt", "-s ses_x", "--agent", "-c"], {
      ...inNovadeck,
      NOVADECK_OPENCODE_SESSION: "ses_outer",
      NOVADECK_OPENCODE_FORK: "1",
    })
    expect(ran.env).toMatchObject({
      NOVADECK_OPENCODE_SESSION: "<unset>",
      NOVADECK_OPENCODE_CONTINUE: "<unset>",
      NOVADECK_OPENCODE_FORK: "<unset>",
    })
    expect(ran.args).toEqual(["--prompt", "-s ses_x", "--agent", "-c"])
  })

  it("strips Novadeck's --variant word, and gives it with the model as its agents' variant", () => {
    const place = setup()
    for (const args of [
      ["--model", "p/m", "--variant", "high"],
      ["-m", "p/m", "--variant=high"],
      ["--variant", "high", "--model=p/m"],
    ]) {
      const ran = run(place, args, inNovadeck)
      expect(ran.args).not.toContain("--variant")
      expect(ran.args).not.toContain("high")
      const agent = { model: "p/m", variant: "high" }
      expect(JSON.parse(ran.env.NOVADECK_OPENCODE_CONFIG!)).toEqual({
        agent: { build: agent, plan: agent },
      })
    }
    expect(
      run(
        place,
        ["--model", "p/m", "--variant", "high", "-s", "ses_a", "--prompt", "--variant", "x y"],
        inNovadeck,
      ).args,
    ).toEqual(["--model", "p/m", "-s", "ses_a", "--prompt", "--variant", "x y"])
  })

  it("drops the variant with no model, or a value of other characters, and keeps a config already set", () => {
    const place = setup()
    const bare = run(place, ["--variant", "high"], inNovadeck)
    expect(bare.args.filter(Boolean)).toEqual([])
    expect(bare.env.NOVADECK_OPENCODE_CONFIG).toBe("<unset>")
    expect(
      run(place, ["--model", "p/m", "--variant", 'h"i'], inNovadeck).env.NOVADECK_OPENCODE_CONFIG,
    ).toBe("<unset>")
    expect(
      run(place, ["--model", "a b", "--variant", "high"], inNovadeck).env.NOVADECK_OPENCODE_CONFIG,
    ).toBe("<unset>")
    const theirs = '{"x":1}'
    const ran = run(place, ["--model", "p/m", "--variant", "high"], {
      ...inNovadeck,
      NOVADECK_OPENCODE_CONFIG: theirs,
    })
    expect(ran.env.NOVADECK_OPENCODE_CONFIG).toBe(theirs)
    expect(ran.args).toEqual(["--model", "p/m"])
  })

  it("passes its commands, help and version through untouched", () => {
    const place = setup()
    for (const args of [
      ["run", "hello"],
      ["--log-level", "DEBUG", "models"],
      ["-v"],
      ["--help"],
      ["mcp", "list"],
    ]) {
      const ran = run(place, args, inNovadeck)
      expect(ran.args).toEqual(args)
      expect(ran.env.OPENCODE_CONFIG_CONTENT).toBe("<unset>")
    }
  })

  it("starts a session where the first word is a project folder, even one named like a command", () => {
    const ran = run(setup(), ["./web"], inNovadeck)
    expect(ran.env.OPENCODE_CONFIG_CONTENT).not.toBe("<unset>")
    expect(ran.args).toEqual(["./web"])
  })

  it("keeps an empty word and every other argument whole", () => {
    expect(run(setup(), ["--prompt", "", "a b", "--", "-s", "x"], inNovadeck).args).toEqual([
      "--prompt",
      "",
      "a b",
      "--",
      "-s",
      "x",
    ])
  })

  it("says so when there is no opencode", () => {
    const place = setup()
    expect(() =>
      execFileSync("sh", [place.shim], { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe" }),
    ).toThrow(/opencode: command not found|status 127/)
  })

  it("doesn't call another Novadeck's shim for the real program", () => {
    const place = setup()
    const other = join(root, "other")
    mkdirSync(other)
    writeFileSync(join(other, "opencode"), posixShim())
    chmodSync(join(other, "opencode"), 0o755)
    const out = run({ ...place, real: `${other}:${place.real}` }, ["-c"], {})
    expect(out.args).toEqual(["-c"])
  })
})

describe("the Windows shim", () => {
  const shim = makeCmdShim()

  it("looks for the real opencode on PATH only, and skips another Novadeck's shim", () => {
    expect(shim).toContain("('where $PATH:opencode 2^>nul')")
    expect(shim).toContain('/c:"rem novadeck shim for opencode"')
  })

  it("loads the plugin through OPENCODE_CONFIG_CONTENT unless the person set it, then through the config folder", () => {
    expect(shim).toContain(
      'set "OPENCODE_CONFIG_CONTENT={"plugin":["%novadeck_slash%/novadeck.mjs"]}"',
    )
    expect(shim).toContain("if defined OPENCODE_CONFIG_CONTENT goto dir")
    expect(shim).toContain("if defined OPENCODE_CONFIG_DIR goto config")
    expect(shim).toContain('set "OPENCODE_CONFIG_DIR=%novadeck_plugin%\\config"')
  })

  it("walks the words as the other shims do, with the session's flags", () => {
    expect(shim).toContain('set "NOVADECK_OPENCODE_SESSION=%~2"')
    expect(shim).toContain(
      'if "%novadeck_arg:~0,10%"=="--session=" set "NOVADECK_OPENCODE_SESSION=%novadeck_arg:~10%"',
    )
    expect(shim).toContain(`for %%c in (${commands.join(" ")}) do`)
    expect(shim).toContain(`for %%v in (${valued.join(" ")}) do`)
    expect(shim).toContain('"%novadeck_real%" %*')
  })

  it("leaves Novadeck's --variant word out of what it runs, and puts the variant in the agents' config", () => {
    expect(shim).toContain('if "%novadeck_arg%"=="--variant" goto variant')
    expect(shim).toContain("if defined novadeck_strip goto stripped")
    expect(shim).toContain(':stripped\n"%novadeck_real%"%novadeck_args%')
    expect(shim).toContain("if defined NOVADECK_OPENCODE_CONFIG goto launch")
    expect(shim).toContain(
      'set "NOVADECK_OPENCODE_CONFIG={"agent":{"build":%novadeck_agent%,"plan":%novadeck_agent%}}"',
    )
  })

  it("runs plain outside a Novadeck terminal", () => {
    expect(shim).toContain("if not defined NOVADECK_TERMINAL_ID goto plain")
    expect(shim).toContain(':plain\n"%novadeck_real%" %*')
  })
})

describe("whether Novadeck's plugin can load", () => {
  const where = (env: NodeJS.ProcessEnv, plugin: string) => ({
    env,
    home: root,
    platform: "linux" as const,
    plugin,
  })

  it("does where the plugin file is there and the person's variables leave room", async () => {
    const { plugins } = setup()
    expect(await hooksTrusted(where({}, plugins), root)).toBe(true)
    expect(await hooksTrusted(where({ OPENCODE_CONFIG_CONTENT: "{}" }, plugins), root)).toBe(true)
  })

  it("doesn't with --pure's variable, with both config variables set, or with no plugin file", async () => {
    const { plugins } = setup()
    expect(await hooksTrusted(where({ OPENCODE_PURE: "1" }, plugins), root)).toBe(false)
    expect(
      await hooksTrusted(
        where({ OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG_DIR: "/x" }, plugins),
        root,
      ),
    ).toBe(false)
    expect(await hooksTrusted(where({}, join(root, "none")), root)).toBe(false)
  })
})

describe("the flags a resume carries", () => {
  it("are the model, agent and variant it reads, and only --auto is given back", () => {
    expect(Object.values(kept.valued).toSorted()).toEqual([
      "--agent",
      "--model",
      "--model",
      "--variant",
    ])
    expect(kept.forgets).toEqual(["--auto"])
  })
})
