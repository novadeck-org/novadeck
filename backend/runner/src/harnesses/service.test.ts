import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { MessageChannel } from "node:worker_threads"

import { agy } from "@novadeck/harness-agy/index"
import { connectRunner } from "@novadeck/runner-client"
import { messagePort } from "@novadeck/wire/client"
import { servePort } from "@novadeck/wire/server"
import { vi } from "vitest"

import { createRunner } from "../index.js"
import { cmdPrints, installShellFiles } from "../shell/install.js"
import type { ShellPaths } from "../shell/scripts.js"
import { describe, expect, it as base } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { createHarnesses, relayVerified } from "./service.js"

const windows = process.platform === "win32"

// Stands in for an agent's `plugin` commands: it records each call and changes the
// agent's own configuration the way the real command does.
const fakeAgent = `
const fs = require("node:fs")
const path = require("node:path")
const [agent, ...args] = process.argv.slice(2)
const home = process.env.HOME
if (args[0] === "--version") {
  if (process.env.FAKE_VERSION !== "none") console.log(process.env.FAKE_VERSION ?? "1.4.10")
  process.exit(0)
}
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify([agent, ...args]) + "\\n")
if (process.env.FAKE_FAIL && args.join(" ").includes(process.env.FAKE_FAIL)) {
  console.error("something went wrong")
  process.exit(1)
}
const command = args.slice(1).filter((arg) => !arg.startsWith("/") && !/^[A-Za-z]:/.test(arg)).join(" ")
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
if (agent === "claude") {
  const file = path.join(home, ".claude", "settings.json")
  if (command === "install novadeck@novadeck") write(file, JSON.stringify({ enabledPlugins: { "novadeck@novadeck": true } }))
  if (command === "uninstall novadeck@novadeck") write(file, JSON.stringify({ enabledPlugins: {} }))
}
if (agent === "codex") {
  const file = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml")
  if (command === "add novadeck@novadeck") write(file, '[plugins."novadeck@novadeck"]\\nenabled = true\\n')
  if (command === "remove novadeck@novadeck") write(file, "")
}
if (agent === "agy") {
  // It copies the plugin folder it installs, as the real one does.
  const folder = path.join(home, ".gemini", "config", "plugins", "novadeck")
  if (command === "install") {
    write(path.join(folder, "plugin.json"), "{}")
    const hooks = path.join(args.at(-1), "hooks.json")
    // FAKE_REWRITE: an agent that changes what it copies.
    if (fs.existsSync(hooks)) write(path.join(folder, "hooks.json"), fs.readFileSync(hooks, "utf8") + (process.env.FAKE_REWRITE ?? ""))
  }
  if (command === "uninstall novadeck") fs.rmSync(folder, { recursive: true, force: true })
}
`

type Fixture = {
  root: string
  home: string
  environment: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  /** Where the stand-in agents are on PATH. */
  bin: string
  paths: ShellPaths
  agents: (env?: NodeJS.ProcessEnv) => ReturnType<typeof createHarnesses>
  calls: () => string[][]
}

const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-agents-"))
    // The relay copied in may still be reading the registry for a background lookup.
    resources.defer(() =>
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    )
    const home = join(root, "home")
    const bin = join(root, "bin")
    mkdirSync(home)
    mkdirSync(bin)
    const script = join(root, "agent.cjs")
    writeFileSync(script, fakeAgent)
    for (const agent of ["claude", "codex", "agy"])
      if (windows)
        writeFileSync(
          join(bin, `${agent}.cmd`),
          `@"${process.execPath}" "${script}" ${agent} %*\r\n`,
        )
      else
        writeFileSync(
          join(bin, agent),
          `#!/bin/sh\nexec "${process.execPath}" "${script}" ${agent} "$@"\n`,
          { mode: 0o755 },
        )
    const log = join(root, "calls.log")
    // Whatever the machine's cmd prints (the quirks lane sets an AutoRun that does).
    const paths = await installShellFiles(join(root, "shell"), {
      prints: () => Promise.resolve(undefined),
    })
    const environment = (env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SHELL: "/bin/sh",
      // Only the stand-ins and system tools: a real agent on this machine never runs.
      PATH: windows
        ? [bin, process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : ""].join(
            delimiter,
          )
        : [bin, "/usr/bin", "/bin"].join(delimiter),
      // Agents' homes inside the fixture; an empty one would mean the working directory.
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      FAKE_LOG: log,
      ...env,
    })
    const agents = (env: NodeJS.ProcessEnv = {}) =>
      createHarnesses(() => Promise.resolve(paths), { home, env: environment(env) })
    const calls = () => {
      try {
        return readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      } catch {
        return []
      }
    }
    await use({ root, home, bin, paths, environment, agents, calls })
  },
})

// The events an Antigravity hooks file registers.
const hookEvents = (path: string) =>
  Object.keys((JSON.parse(readFileSync(path, "utf8")) as { novadeck: object }).novadeck)

const installed = (home: string, ...agents: string[]) => {
  const homes = { claude: [".claude"], codex: [".codex"], agy: [".gemini", "antigravity-cli"] }
  for (const agent of agents)
    mkdirSync(join(home, ...homes[agent as keyof typeof homes]), { recursive: true })
}

describe("agents Novadeck can connect", () => {
  it("are available only where their own home exists", async ({ fixture }) => {
    installed(fixture.home, "codex")
    expect(await fixture.agents().list()).toEqual([
      { agent: "claude", available: false, connected: false },
      { agent: "codex", available: true, connected: false },
      { agent: "agy", available: false, connected: false },
    ])
  })

  it("connect Claude Code through its own plugin commands, from Novadeck's marketplace", async ({
    fixture,
  }) => {
    installed(fixture.home, "claude")
    const agents = fixture.agents()
    expect(await agents.set("claude", true)).toEqual({
      agent: "claude",
      available: true,
      connected: true,
    })
    expect(fixture.calls()).toEqual([
      ["claude", "plugin", "marketplace", "remove", "novadeck"],
      ["claude", "plugin", "marketplace", "add", fixture.paths.plugins.claude],
      ["claude", "plugin", "install", "novadeck@novadeck"],
    ])
    expect(await agents.set("claude", false)).toMatchObject({ connected: false })
    expect(fixture.calls().slice(3)).toEqual([
      ["claude", "plugin", "uninstall", "novadeck@novadeck"],
      ["claude", "plugin", "marketplace", "remove", "novadeck"],
    ])
  })

  it("connect Codex and Antigravity the same way", async ({ fixture }) => {
    installed(fixture.home, "codex", "agy")
    const agents = fixture.agents()
    await agents.set("codex", true)
    await agents.set("agy", true)
    expect(await agents.list()).toEqual([
      { agent: "claude", available: false, connected: false },
      { agent: "codex", available: true, connected: true },
      { agent: "agy", available: true, connected: true },
    ])
    expect(fixture.calls()).toContainEqual(["codex", "plugin", "add", "novadeck@novadeck"])
    expect(fixture.calls()).toContainEqual(["agy", "plugin", "install", fixture.paths.plugins.agy])
    // Antigravity's status line, which only its settings name, runs Novadeck's hook too.
    const settings = join(fixture.home, ".gemini", "antigravity-cli", "settings.json")
    const statusLine = () =>
      (JSON.parse(readFileSync(settings, "utf8")) as { statusLine?: { command: string } })
        .statusLine
    expect(statusLine()?.command).toContain(
      windows ? "%NOVADECK_HOOK% agy StatusLine" : '"$NOVADECK_HOOK" agy StatusLine',
    )
    await agents.set("agy", false)
    expect((await agents.list())[2]).toMatchObject({ connected: false })
    expect(statusLine()).toBeUndefined()
  })

  it("install the plugin again where an agent's own copy of it differs from Novadeck's", async ({
    fixture,
  }) => {
    installed(fixture.home, "agy", "codex")
    const agents = fixture.agents()
    // Not connected yet: nothing to refresh.
    expect(await agents.refresh()).toEqual([])
    await agents.set("agy", true)
    const copy = join(fixture.home, ".gemini", "config", "plugins", "novadeck", "hooks.json")
    const ours = join(fixture.paths.plugins.agy, "hooks.json")
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(ours, "utf8"))
    // Its copy matches: no command runs.
    const before = fixture.calls().length
    expect(await agents.refresh()).toEqual([])
    expect(fixture.calls()).toHaveLength(before)
    // Novadeck renders its hooks otherwise now, as where cmd prints first.
    writeFileSync(ours, '{"novadeck":{}}')
    expect(await agents.refresh()).toEqual(["agy"])
    expect(fixture.calls().slice(before)).toContainEqual([
      "agy",
      "plugin",
      "install",
      fixture.paths.plugins.agy,
    ])
    expect(readFileSync(copy, "utf8")).toBe('{"novadeck":{}}')
    expect(await agents.refresh()).toEqual([])
  })

  // Windows CI's quirks job sets an AutoRun that prints (NOVADECK_TEST_CMD_AUTORUN=1), which
  // no test may on a developer's machine.
  it.runIf(process.platform === "win32" && process.env.NOVADECK_TEST_CMD_AUTORUN === "1")(
    "take PreToolUse out of a connected Antigravity's copy where cmd prints before every command",
    async ({ fixture }) => {
      expect(await cmdPrints()).toBe("prints")
      installed(fixture.home, "agy")
      // Shell files written as this machine's cmd has it.
      const printing = await installShellFiles(join(fixture.root, "shell-printing"))
      const agents = createHarnesses(() => Promise.resolve(printing), {
        home: fixture.home,
        env: fixture.environment(),
      })
      expect(hookEvents(join(printing.plugins.agy, "hooks.json"))).not.toContain("PreToolUse")
      // Connected before cmd printed: its copy still has Antigravity ask Novadeck first.
      await agents.set("agy", true)
      // No launch grant on such a machine, whatever the plugin and the relay.
      expect(await agents.verified("agy")).toBe(false)
      const copy = join(fixture.home, ".gemini", "config", "plugins", "novadeck", "hooks.json")
      const asking = agy
        .files("win32", { mcp: { command: "mcp" }, hook: { command: "relay" } })
        .find(({ path }) => path === "hooks.json")!.content
      writeFileSync(copy, asking)
      expect(hookEvents(copy)).toContain("PreToolUse")
      expect(await agents.refresh()).toEqual(["agy"])
      expect(hookEvents(copy)).not.toContain("PreToolUse")
    },
  )

  it("leave Antigravity's plugin as it is while a terminal runs it", async ({ fixture }) => {
    installed(fixture.home, "agy")
    const agents = fixture.agents()
    await agents.set("agy", true)
    // Novadeck renders its hooks otherwise now, which would reinstall the plugin.
    writeFileSync(join(fixture.paths.plugins.agy, "hooks.json"), '{"novadeck":{}}')
    const before = fixture.calls().length
    agents.track({ running: () => ["@fox"], narrowed: () => [] })
    expect(await agents.refresh()).toEqual([])
    expect(fixture.calls()).toHaveLength(before)
    agents.track({ running: () => [], narrowed: () => [] })
    expect(await agents.refresh()).toEqual(["agy"])
  })

  it("leave Antigravity's plugin as it is when a previous runner left a narrowed terminal", async ({
    fixture,
  }) => {
    installed(fixture.home, "agy")
    const left = createHarnesses(
      () => Promise.resolve({ ...fixture.paths, narrowedBefore: true }),
      {
        home: fixture.home,
        env: fixture.environment(),
      },
    )
    await left.set("agy", true)
    writeFileSync(join(fixture.paths.plugins.agy, "hooks.json"), '{"novadeck":{}}')
    const before = fixture.calls().length
    expect(await left.refresh()).toEqual([])
    expect(fixture.calls()).toHaveLength(before)
  })

  it("refuse to disconnect Antigravity under a running terminal's grant, naming it", async ({
    fixture,
  }) => {
    installed(fixture.home, "agy", "claude")
    const agents = fixture.agents()
    await agents.set("agy", true)
    await agents.set("claude", true)
    agents.track({ running: () => ["@fox", "@owl"], narrowed: () => ["@fox"] })
    await expect(agents.set("agy", false)).rejects.toThrow(/@fox/)
    expect(await agents.connected("agy")).toBe(true)
    // Another harness has no launch grants to protect, and a terminal not narrowed none either.
    await agents.set("claude", false)
    expect(await agents.connected("claude")).toBe(false)
    agents.track({ running: () => ["@fox"], narrowed: () => [] })
    await agents.set("agy", false)
    expect(await agents.connected("agy")).toBe(false)
  })

  it("refuse to install Antigravity's plugin over itself while a terminal runs it", async ({
    fixture,
  }) => {
    installed(fixture.home, "agy")
    const agents = fixture.agents()
    agents.track({ running: () => ["@fox"], narrowed: () => [] })
    // Not installed yet: there is no hook for a running terminal to lose.
    await agents.set("agy", true)
    const before = fixture.calls().length
    await expect(agents.set("agy", true)).rejects.toThrow(/@fox/)
    expect(fixture.calls()).toHaveLength(before)
    expect(await agents.connected("agy")).toBe(true)
  })

  /* eslint-disable no-await-in-loop -- Each version is tried in turn. */
  it("give Antigravity launch grants only from a version that takes --settings", async ({
    fixture,
  }) => {
    installed(fixture.home, "agy")
    for (const [version, expected] of [
      ["1.4.3", false],
      ["none", false],
      ["1.4.10", true],
      ["1.5.0", true],
    ] as const) {
      const agents = fixture.agents({ FAKE_VERSION: version })
      await agents.set("agy", true)
      expect(await agents.verified("agy"), version).toBe(expected)
    }
  })

  /* eslint-enable no-await-in-loop */
  it("verify Antigravity's plugin only when it is connected, as rendered, and not being reinstalled", async ({
    fixture,
  }) => {
    installed(fixture.home, "agy", "claude")
    const agents = fixture.agents()
    expect(await agents.verified("agy")).toBe(false)
    await agents.set("agy", true)
    expect(await agents.verified("agy")).toBe(true)
    const marker = `${fixture.paths.plugins.agy}.reinstalling`
    writeFileSync(marker, "")
    expect(await agents.verified("agy")).toBe(false)
    rmSync(marker)
    writeFileSync(join(fixture.paths.plugins.agy, "hooks.json"), '{"novadeck":{}}')
    expect(await agents.verified("agy")).toBe(false)
    // A harness that keeps no copy of its plugin has nothing to verify.
    await agents.set("claude", true)
    expect(await agents.verified("claude")).toBe(false)
  })

  it("verify the relay Windows' hook runs alone, byte for byte, and never where cmd prints", async ({
    fixture,
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-relay-verified-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const shipped = join(folder, "shipped.exe")
    const plugin = join(folder, "plugin")
    mkdirSync(plugin)
    const where = { env: {}, home: folder, platform: "win32", plugin } as const
    const shell = (over: object = {}) =>
      ({ ...fixture.paths, relay: join(folder, "installed.exe"), ...over }) as typeof fixture.paths
    writeFileSync(shipped, "relay v1")
    writeFileSync(join(folder, "installed.exe"), "relay v1")
    writeFileSync(join(plugin, "hooks.json"), '{"novadeck":{"PreToolUse":[]}}')
    expect(await relayVerified(shell(), shipped, where)).toBe(true)
    // An installed relay that differs by a byte, or is missing, or an unreadable shipped one.
    writeFileSync(join(folder, "installed.exe"), "relay v2")
    expect(await relayVerified(shell(), shipped, where)).toBe(false)
    expect(await relayVerified(shell({ relay: join(folder, "none.exe") }), shipped, where)).toBe(
      false,
    )
    writeFileSync(join(folder, "installed.exe"), "relay v1")
    expect(await relayVerified(shell(), join(folder, "none"), where)).toBe(false)
    // cmd printing first: no hook to give a grant, even with every file as shipped.
    expect(await relayVerified(shell({ cmdPrints: true }), shipped, where)).toBe(false)
    // A plugin that registers no PreToolUse (no path cmd reads as it is, or cmd printed).
    writeFileSync(join(plugin, "hooks.json"), '{"novadeck":{"Stop":[]}}')
    expect(await relayVerified(shell(), shipped, where)).toBe(false)
    rmSync(join(plugin, "hooks.json"))
    expect(await relayVerified(shell(), shipped, where)).toBe(false)
  })

  it("never undo a disconnect asked for before the refresh looked", async ({ fixture }) => {
    installed(fixture.home, "agy")
    const agents = fixture.agents()
    await agents.set("agy", true)
    writeFileSync(join(fixture.paths.plugins.agy, "hooks.json"), '{"novadeck":{}}')
    // The person turns it off as Novadeck starts: their change goes first.
    const off = agents.set("agy", false)
    const refreshed = agents.refresh()
    await off
    expect(await refreshed).toEqual([])
    expect(await agents.connected("agy")).toBe(false)
  })

  it("finish at the next start a reinstall a quit cut short, unless disconnected since", async ({
    fixture,
  }) => {
    installed(fixture.home, "agy")
    const agents = fixture.agents()
    const marker = `${fixture.paths.plugins.agy}.reinstalling`
    // Uninstalled, not installed again yet: it looks disconnected.
    writeFileSync(marker, "")
    expect(await agents.connected("agy")).toBe(false)
    expect(await agents.refresh()).toEqual(["agy"])
    expect(await agents.connected("agy")).toBe(true)
    expect(existsSync(marker)).toBe(false)
    // A disconnect the person asks for takes the mark away with it.
    writeFileSync(marker, "")
    await agents.set("agy", false)
    expect(existsSync(marker)).toBe(false)
    expect(await agents.refresh()).toEqual([])
    expect(await agents.connected("agy")).toBe(false)
  })

  it("drop an unfinished reinstall for an agent uninstalled since", async ({ fixture }) => {
    const agents = fixture.agents()
    const marker = `${fixture.paths.plugins.agy}.reinstalling`
    // Antigravity's home is gone: the mark goes, and nothing is installed.
    writeFileSync(marker, "")
    expect(await agents.refresh()).toEqual([])
    expect(existsSync(marker)).toBe(false)
    expect(fixture.calls()).toEqual([])
  })

  it("say so where the agent's copy still differs once installed again", async ({ fixture }) => {
    installed(fixture.home, "agy")
    const agents = fixture.agents({ FAKE_REWRITE: " " })
    await agents.set("agy", true)
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await agents.refresh()).toEqual(["agy"])
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("its copy still differs"))
    } finally {
      logged.mockRestore()
    }
  })

  it.skipIf(windows)(
    "find an agent home the login shell moves, as a desktop-launched app would not",
    async ({ fixture }) => {
      const moved = join(fixture.home, "codex-elsewhere")
      mkdirSync(moved)
      // sh reads $ENV when interactive, as bash and zsh read their rc files.
      const profile = join(fixture.home, "profile.sh")
      writeFileSync(profile, `export CODEX_HOME="${moved}"\n`)
      const agents = fixture.agents({ ENV: profile })
      // Connecting waits for the login environment; listing uses it once known.
      expect(await agents.set("codex", true)).toMatchObject({ available: true, connected: true })
      expect(readFileSync(join(moved, "config.toml"), "utf8")).toContain("novadeck@novadeck")
      expect((await agents.list())[1]).toEqual({ agent: "codex", available: true, connected: true })
    },
  )

  it.skipIf(windows)(
    "keep the environment they are given as it is when told not to read the login shell's",
    async ({ fixture }) => {
      installed(fixture.home, "codex")
      const moved = join(fixture.home, "codex-elsewhere")
      mkdirSync(moved)
      const profile = join(fixture.home, "profile.sh")
      writeFileSync(profile, `export CODEX_HOME="${moved}"\n`)
      const agents = createHarnesses(() => Promise.resolve(fixture.paths), {
        home: fixture.home,
        env: fixture.environment({ ENV: profile }),
        login: false,
      })
      expect(await agents.set("codex", true)).toMatchObject({ available: true, connected: true })
      expect(readFileSync(join(fixture.home, ".codex", "config.toml"), "utf8")).toContain(
        "novadeck@novadeck",
      )
      expect(existsSync(join(moved, "config.toml"))).toBe(false)
    },
  )

  it.skipIf(windows)(
    "do not wait on a background job the login shell's startup files leave running",
    async ({ fixture }) => {
      installed(fixture.home, "claude")
      const shell = join(fixture.home, "slow-shell")
      writeFileSync(shell, '#!/bin/sh\nsleep 30 &\nexec /bin/sh "$@"\n', { mode: 0o755 })
      const started = Date.now()
      await fixture.agents({ SHELL: shell }).set("claude", true)
      expect(Date.now() - started).toBeLessThan(10_000)
    },
  )

  it.skipIf(windows)(
    "connect Claude Code's local install, which only an alias names",
    async ({ fixture }) => {
      installed(fixture.home, "claude")
      const local = join(fixture.home, ".claude", "local")
      mkdirSync(local)
      const script = readFileSync(join(fixture.bin, "claude"), "utf8")
      writeFileSync(join(local, "claude"), script, { mode: 0o755 })
      rmSync(join(fixture.bin, "claude"))
      expect(await fixture.agents().set("claude", true)).toMatchObject({ connected: true })
    },
  )

  it("say why an agent could not be connected", async ({ fixture }) => {
    installed(fixture.home, "claude")
    await expect(
      fixture.agents({ FAKE_FAIL: "install" }).set("claude", true),
    ).rejects.toMatchObject({
      code: "AGENT_SETUP_FAILED",
      message: expect.stringContaining("something went wrong"),
    })
    await expect(fixture.agents().set("codex", true)).rejects.toMatchObject({
      code: "AGENT_SETUP_FAILED",
    })
  })
})

// The runner's shells run bash with the fixture's home and stand-ins, as elsewhere here.
describe.skipIf(windows)("resuming an agent's saved session", () => {
  it("happens only while the agent is connected, and disconnecting forgets it", async ({
    fixture,
    resources,
  }) => {
    installed(fixture.home, "claude")
    const database = join(fixture.root, "data", "workspace.sqlite")
    const [before, after] = [randomUUID(), randomUUID()]
    const saved = new WorkspaceStore(database)
    resources.defer(() => saved.close())
    const project = await saved.createProject({ id: randomUUID(), name: "P", cwd: fixture.home })
    const session = saved.createSession({ id: randomUUID(), projectId: project.id, name: "S" })
    for (const [id, sessionId] of [
      [before, "before-connecting"],
      [after, "after-connecting"],
    ] as const)
      saved.saveTerminal({
        id,
        sessionId: session.id,
        cwd: fixture.home,
        agents: { claude: { sessionId, seq: 1 } },
        promptedAt: null,
        handle: id === before ? "moth" : "fox",
        naming: { person: null, opener: null, murmur: null, summary: null },
        openedBy: null,
        ledBy: null,
        command: null,
        lastProgram: null,
        work: null,
      })
    const runner = createRunner({
      database,
      shell: join(fixture.root, "data", "shell"),
      agents: { home: fixture.home, env: fixture.environment() },
      terminals: { shell: "/bin/bash", env: fixture.environment() },
    })
    resources.defer(() => runner.close())
    const { port1, port2 } = new MessageChannel()
    servePort(runner.sessions, port1)
    const client = await connectRunner(messagePort(() => Promise.resolve(port2)))
    resources.defer(() => client.close())
    const restore = (id: string) =>
      client.terminals.create({
        id,
        sessionId: session.id,
        cols: 80,
        rows: 24,
        restore: true,
        resume: "claude",
      })

    await restore(before)
    await client.agents.set("claude", true)
    await restore(after)
    // A connected Claude Code runs through Novadeck's shim, which adds its status line.
    const resumed = (id: string) =>
      fixture
        .calls()
        .some((call) => call[0] === "claude" && call.slice(-2).join(" ") === `--resume ${id}`)
    await expect.poll(() => resumed("after-connecting"), { timeout: 10_000 }).toBe(true)
    // By now the first shell is long at its prompt, where it would have resumed.
    expect(resumed("before-connecting")).toBe(false)
    await client.agents.set("claude", false)
    expect(saved.terminal(after)?.agents).toEqual({})
  })

  it("lists the models an agent starts with, as its harness tells them", async ({ fixture }) => {
    mkdirSync(join(fixture.home, ".claude"), { recursive: true })
    const agents = fixture.agents()
    expect((await agents.models("claude")).map(({ id }) => id)).toContain("opus")
    // Codex's are the ones its own cache lists.
    mkdirSync(join(fixture.home, ".codex"), { recursive: true })
    writeFileSync(
      join(fixture.home, ".codex", "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-x",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          },
        ],
      }),
    )
    expect(await agents.models("codex")).toEqual([{ id: "gpt-x", efforts: ["low", "high"] }])
  })

  it("lists none for an agent that isn't installed, or whose list can't be read", async ({
    fixture,
  }) => {
    const agents = fixture.agents()
    expect(await agents.models("claude")).toEqual([])
    mkdirSync(join(fixture.home, ".codex"), { recursive: true })
    writeFileSync(join(fixture.home, ".codex", "models_cache.json"), "{ not json")
    expect(await agents.models("codex")).toEqual([])
  })
})
