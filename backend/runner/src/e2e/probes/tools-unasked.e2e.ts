// PROBE: which launch words let a harness run Novadeck's own MCP tools without asking, with
// nothing in its settings allowing them. Per harness, each case starts it with its words (bare
// first, which must ask), has the model call `describe`, and records whether the call ran or
// the harness asked, with the screen. Runs only with NOVADECK_E2E_PROBES=1, by path; with
// PROBE_OUT set it writes $PROBE_OUT/<agent>.tools-unasked.probe.json.
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
  /** Leaves the seed's allow of Novadeck's tools in its settings. */
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
}

const slug = (label: string): string => label.replace(/[^a-z0-9]+/gi, "-")

/** Takes the seed's allow of Novadeck's tools away, so only the launch words can allow them. */
const unseed = (run: E2E, agent: AgentName): void => {
  const edit = (path: string, change: (text: string) => string): void =>
    writeFileSync(path, change(readFileSync(path, "utf8")))
  const home = run.sandbox.home
  if (agent === "claude")
    edit(join(home, ".claude", "settings.json"), (text) =>
      text.replace(/"mcp__plugin_novadeck_novadeck",?/, ""),
    )
  if (agent === "codex")
    edit(join(home, ".codex", "config.toml"), (text) =>
      text.replace(/^default_tools_approval_mode\s*=.*$/m, ""),
    )
  if (agent === "agy")
    edit(join(home, ".gemini", "antigravity-cli", "settings.json"), (text) =>
      text.replace(/"mcp\(novadeck_novadeck\/\*\)",?/, ""),
    )
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
          if (!probe.seeded) unseed(run, agent)
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
          found.command = `${agent} ${words}`.trim()
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
