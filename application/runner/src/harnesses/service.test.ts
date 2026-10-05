import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { MessageChannel } from "node:worker_threads"

import { connectRunner, messagePort } from "@novadeck/protocol/client"

import { createRunner, servePort } from "../index.js"
import { installShellFiles } from "../shell/install.js"
import type { ShellPaths } from "../shell/scripts.js"
import { describe, expect, it as base } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { createHarnesses } from "./service.js"

const windows = process.platform === "win32"

// Stands in for an agent's `plugin` commands: it records each call and changes the
// agent's own configuration the way the real command does.
const fakeAgent = `
const fs = require("node:fs")
const path = require("node:path")
const [agent, ...args] = process.argv.slice(2)
const home = process.env.HOME
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
  const file = path.join(home, ".gemini", "config", "plugins", "novadeck", "plugin.json")
  if (command === "install") write(file, "{}")
  if (command === "uninstall novadeck") fs.rmSync(file, { force: true })
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
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
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
    const paths = await installShellFiles(join(root, "shell"))
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
    if (!windows) expect(statusLine()?.command).toContain('"$NOVADECK_HOOK" agy StatusLine')
    await agents.set("agy", false)
    expect((await agents.list())[2]).toMatchObject({ connected: false })
    if (!windows) expect(statusLine()).toBeUndefined()
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
        handle: "t1",
        naming: { person: null, agent: null, summary: null },
        openedBy: null,
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
    servePort(runner, port1)
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
})
