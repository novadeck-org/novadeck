// PROBE: which launch words let a harness run Novadeck's own MCP tools without asking, with
// nothing in its settings allowing them. Per harness, each case starts it past Novadeck's shim,
// which would add its own allow (an empty NOVADECK_SHIMS, with what else the shim adds that
// Novadeck needs), with the case's words (bare first, which must ask), has the model call
// `describe`, and records whether the call ran or the harness asked, with the screen. One more
// for Antigravity goes through its shim and records where an "always allow" the person picks
// is saved while `--settings` holds the session's rules. Runs only with NOVADECK_E2E_PROBES=1,
// by path; with PROBE_OUT set it writes $PROBE_OUT/<agent>.<case>.tools-unasked.probe.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { setups } from "../agents/index.js"
import { describe, e2e, expect, supported } from "../fixture.js"
import type { E2E } from "../fixture.js"
import { asked, tool } from "../model/script.js"
import { own, prompted, result } from "../scenarios.js"

const out = process.env.PROBE_OUT

type Case = {
  readonly label: string
  /** What follows the program's name. */
  readonly words: (run: E2E) => string
  /** The prompt is on the command line, not typed. */
  readonly positional?: true
  /** Allows Novadeck's tools in the harness's own settings first. */
  readonly seeded?: true
  /** Changes the harness's settings first. */
  readonly prepare?: (run: E2E) => void
}

const claudeSettings = (run: E2E, change: (settings: Record<string, any>) => void): void => {
  const path = join(run.sandbox.home, ".claude", "settings.json")
  const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
  change(settings)
  writeFileSync(path, JSON.stringify(settings))
}

const flagSettings = (run: E2E, settings: object): string => {
  const path = join(run.sandbox.root, "claude-flag-settings.json")
  writeFileSync(path, JSON.stringify(settings))
  return path
}

const agySettings = (run: E2E, allow: readonly string[]): string => {
  const path = join(run.sandbox.root, `agy-allow-${allow.length}.json`)
  writeFileSync(path, JSON.stringify({ permissions: { allow } }))
  return path
}

const codexKey = "mcp_servers.novadeck.default_tools_approval_mode=approve"

const cases: { readonly [agent in AgentName]: readonly Case[] } = {
  claude: [
    { label: "bare", words: () => "" },
    { label: "allowed-tools=", words: () => "--allowed-tools=mcp__plugin_novadeck_novadeck" },
    {
      label: "allowed-tools= then the person's",
      words: () => "--allowed-tools=mcp__plugin_novadeck_novadeck --allowed-tools Bash",
    },
    {
      label: "allowed-tools= then a prompt",
      words: () => `--allowed-tools=mcp__plugin_novadeck_novadeck "Describe this terminal"`,
      positional: true,
    },
    {
      label: "allowed-tools= in plan mode",
      words: () => "--allowed-tools=mcp__plugin_novadeck_novadeck --permission-mode plan",
    },
    {
      label: "settings allow in plan mode",
      words: () => "--permission-mode plan",
      seeded: true,
    },
    {
      label: "flag settings allow in plan mode",
      words: (run) =>
        `--permission-mode plan --settings ${flagSettings(run, { permissions: { allow: ["mcp__plugin_novadeck_novadeck"] } })}`,
    },
    {
      label: "bare in auto mode",
      words: () => "--permission-mode auto",
      prepare: (run) =>
        claudeSettings(run, (settings) => {
          delete settings.permissions.disableAutoMode
        }),
    },
    {
      label: "allowed-tools= in auto mode",
      words: () => "--allowed-tools=mcp__plugin_novadeck_novadeck --permission-mode auto",
      prepare: (run) =>
        claudeSettings(run, (settings) => {
          delete settings.permissions.disableAutoMode
        }),
    },
    {
      label: "allowed-tools= in acceptEdits mode",
      words: () => "--allowed-tools=mcp__plugin_novadeck_novadeck --permission-mode acceptEdits",
    },
  ],
  codex: [
    { label: "bare", words: () => "" },
    { label: "-c unquoted", words: () => `-c plugins.novadeck@novadeck.${codexKey}` },
    { label: "-c quoted", words: () => `-c 'plugins."novadeck@novadeck".${codexKey}'` },
    {
      label: "-c unquoted, read-only on request",
      words: () =>
        `--ask-for-approval on-request --sandbox read-only -c plugins.novadeck@novadeck.${codexKey}`,
    },
  ],
  agy: [
    { label: "bare", words: () => "" },
    {
      label: "--settings file",
      words: (run) => `--settings ${agySettings(run, ["mcp(novadeck_novadeck/*)"])}`,
    },
    {
      label: "--settings inline",
      words: () =>
        `--settings '${JSON.stringify({ permissions: { allow: ["mcp(novadeck_novadeck/*)"] } })}'`,
    },
    {
      label: "--settings unrelated, seeded",
      words: (run) => `--settings ${agySettings(run, ["command(echo unrelated)"])}`,
      seeded: true,
    },
    {
      label: "--settings deny only, seeded",
      words: (run) => {
        const path = join(run.sandbox.root, "agy-deny.json")
        writeFileSync(path, JSON.stringify({ permissions: { deny: ["command(echo zzz)"] } }))
        return `--settings ${path}`
      },
      seeded: true,
    },
    {
      label: "--settings other key only, seeded",
      words: () => `--settings '${JSON.stringify({ pickerGrouping: "none" })}'`,
      seeded: true,
    },
    {
      label: "--settings ours then the person's unrelated",
      words: (run) =>
        `--settings ${agySettings(run, ["mcp(novadeck_novadeck/*)"])} --settings ${agySettings(run, ["command(echo a)", "command(echo b)"])}`,
    },
    {
      label: "--settings the person's unrelated then ours",
      words: (run) =>
        `--settings ${agySettings(run, ["command(echo a)", "command(echo b)"])} --settings ${agySettings(run, ["mcp(novadeck_novadeck/*)"])}`,
    },
    {
      label: "--settings file in plan mode",
      words: (run) => `--mode plan --settings ${agySettings(run, ["mcp(novadeck_novadeck/*)"])}`,
    },
  ],
  // Novadeck's plugin adds its tools' allow to the configuration opencode loaded, so the
  // bare launch is the one that matters.
  opencode: [{ label: "bare", words: () => "" }],
}

const slug = (label: string): string => label.replace(/[^a-z0-9]+/gi, "-")

/** Allows Novadeck's tools in the harness's own settings, as a person may have. */
const seedAllow = (run: E2E, agent: AgentName): void => {
  const home = run.sandbox.home
  const allowIn = (path: string, rule: string): void => {
    const settings = JSON.parse(readFileSync(path, "utf8")) as {
      permissions?: { allow?: string[] }
    }
    const permissions = settings.permissions ?? {}
    writeFileSync(
      path,
      JSON.stringify({
        ...settings,
        permissions: { ...permissions, allow: [...(permissions.allow ?? []), rule] },
      }),
    )
  }
  if (agent === "claude")
    allowIn(join(home, ".claude", "settings.json"), "mcp__plugin_novadeck_novadeck")
  if (agent === "agy")
    allowIn(join(home, ".gemini", "antigravity-cli", "settings.json"), "mcp(novadeck_novadeck/*)")
  if (agent === "opencode") {
    const path = join(home, ".config", "opencode", "opencode.json")
    const settings = JSON.parse(readFileSync(path, "utf8")) as { permission?: object }
    writeFileSync(
      path,
      JSON.stringify({
        ...settings,
        permission: { ...settings.permission, "novadeck_*": "allow" },
      }),
    )
  }
}

/**
 * What starts a harness past Novadeck's shim, and what else of the shim's it needs: Codex's
 * session in its terminal and the title that says its prompt is up (harnesses/codex/src/shim.ts).
 */
const past: { readonly [agent in AgentName]: string } = {
  claude: "NOVADECK_SHIMS= claude",
  codex: `NOVADECK_SHIMS= codex --no-daemon -c "tui.terminal_title=['status','thread-id']"`,
  agy: "NOVADECK_SHIMS= agy",
  opencode: "NOVADECK_SHIMS= opencode",
}

for (const setup of setups) {
  const agent = setup.agent
  describe.skipIf(!supported || process.env.NOVADECK_E2E_PROBES === undefined)(
    `probe: Novadeck's tools unasked in ${setup.name}`,
    () => {
      const it = e2e(setup)
      // PROBE_CASES names the cases to run, by their labels with dashes for spaces.
      const only = process.env.PROBE_CASES?.split(",")
      for (const probe of cases[agent].filter((one) => !only || only.includes(slug(one.label))))
        it(probe.label, async ({ e2e: run }) => {
          if (probe.seeded) seedAllow(run, agent)
          probe.prepare?.(run)
          const found: Record<string, unknown> = { case: probe.label }
          run.model.use(
            own((call) => {
              const describeIt = tool(call, "describe")
              return describeIt && asked(call, "Describe this terminal")
                ? { calls: [{ name: describeIt, input: { title: "Heron", summary: "Heron." } }] }
                : undefined
            }),
            own((call) =>
              result(call)?.includes("Described this terminal")
                ? { text: "Described unasked." }
                : undefined,
            ),
          )
          const words = probe.words(run)
          found.command = `${past[agent]} ${words}`.trim()
          const terminal = await run.deck.open(found.command as string)
          await terminal.reached("ready", { timeoutMs: 60_000 })
          // Claude Code offers to keep auto mode as the default before its prompt.
          if (probe.label.includes("auto mode"))
            await terminal.confirm(/❯ Yes, set auto mode as my default/, async () => {})
          if (!probe.positional) {
            await prompted(terminal, setup)
            await terminal.submit("Describe this terminal")
          }
          try {
            await terminal.until("Described unasked.", 30_000)
            found.ran = true
          } catch {
            found.ran = false
          }
          found.screen = await terminal.screen()
          if (out) {
            mkdirSync(out, { recursive: true })
            const name = slug(probe.label)
            writeFileSync(
              join(out, `${agent}.${name}.tools-unasked.probe.json`),
              JSON.stringify(found, null, 2),
            )
          }
          expect(found).toBeDefined()
        })
    },
  )
}

// Antigravity through its shim, the person's own rule in settings.json: they pick "always
// allow" on a command, persisted. Where does it go: their settings.json (with Novadeck's rule
// too?), or the shim's file? And the next launch's file holds what?
const antigravity = setups.find((setup) => setup.agent === "agy")
describe.skipIf(
  !supported || process.env.NOVADECK_E2E_PROBES === undefined || antigravity === undefined,
)("probe: an always-allow Antigravity saves while the shim's --settings holds its rules", () => {
  const setup = antigravity!
  const it = e2e(setup)
  it("records the person's settings and the shim's file after a persisted allow", async ({
    e2e: run,
  }) => {
    const settings = join(run.sandbox.home, ".gemini", "antigravity-cli", "settings.json")
    const before = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>
    writeFileSync(
      settings,
      JSON.stringify({ ...before, permissions: { allow: ["command(echo kept)"] } }),
    )
    const found: Record<string, unknown> = { before: readFileSync(settings, "utf8") }
    run.model.use(
      own((call) =>
        asked(call, "Run the echo") && result(call) === undefined
          ? {
              calls: [
                {
                  name: "run_command",
                  input: {
                    CommandLine: "echo persisted",
                    WaitMsBeforeAsync: 5000,
                    toolSummary: "Echo",
                  },
                },
              ],
            }
          : undefined,
      ),
      own((call) => (result(call) !== undefined ? { text: "Ran it." } : undefined)),
    )
    const terminal = await run.deck.open("agy")
    await terminal.reached("ready", { timeoutMs: 60_000 })
    await prompted(terminal, setup)
    const file = (id: string): string => join(run.deck.shell.allow, `${id}.json`)
    found.passed = readFileSync(file(terminal.id), "utf8")
    await terminal.submit("Run the echo")
    found.dialog = await terminal.until(/Yes, run command/, 30_000)
    // Its third choice persists the rule to settings.json, picked by its number alone.
    await terminal.settled()
    terminal.press("3")
    try {
      await terminal.until("Ran it.", 30_000)
      found.ran = true
    } catch {
      found.ran = false
    }
    found.screen = await terminal.screen()
    found.after = readFileSync(settings, "utf8")
    found.passedAfter = readFileSync(file(terminal.id), "utf8")
    // The next launch, in another terminal.
    const next = await run.deck.open("agy")
    await next.reached("ready", { timeoutMs: 60_000 })
    found.nextPassed = readFileSync(file(next.id), "utf8")
    if (out) {
      mkdirSync(out, { recursive: true })
      writeFileSync(
        join(out, "agy.persisted.tools-unasked.probe.json"),
        JSON.stringify(found, null, 2),
      )
    }
    expect(found).toBeDefined()
  })
})
