// PROBE, not a test of Novadeck: how Codex and Antigravity show an MCP server's elicitation
// (a form the server asks the person to fill), which no hook of theirs reports: its screen at
// several widths, for one field and several, and what the screen and the records show once it
// is answered or cancelled. Writes `elicit-<agent>-<form>.json` to PROBE_OUT. Runs only with
// NOVADECK_E2E_PROBES=1, by path.
/* eslint-disable no-await-in-loop -- A probe's steps run in order. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { screenRecord, type ScreenRecord } from "@novadeck/harness-core/testing/probes"

import type { AgentSetup } from "../agents/agent.js"
import { agy } from "../agents/agy.js"
import { codex } from "../agents/codex.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, selected, supported, type E2E } from "../fixture.js"
import type { Call } from "../model/script.js"
import { answers, own, result, start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.env.HOME ?? ".", "probe-out")
mkdirSync(out, { recursive: true })

const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        try {
          return statSync(path).isDirectory() ? files(path) : [path]
        } catch {
          return []
        }
      })
    : []

const object = (properties: object, required: string[] = []) => ({
  type: "object",
  properties,
  required,
})

type Form = {
  readonly name: string
  readonly message: string
  readonly schema: object
  // What answers it, step by step: keys pressed, or text typed and submitted with Enter.
  readonly keys: readonly (string | { readonly submit: string })[]
}

const forms: readonly Form[] = [
  {
    name: "enum",
    message: "Which colour do you want?",
    schema: object({ colour: { type: "string", title: "Colour", enum: ["red", "green"] } }, [
      "colour",
    ]),
    keys: ["2"],
  },
  {
    name: "text",
    message: "What is your name?",
    schema: object({ name: { type: "string", title: "Name" } }, ["name"]),
    keys: [{ submit: "Ada" }],
  },
  {
    name: "mixed",
    message: "Tell us about yourself",
    schema: object(
      {
        name: { type: "string", title: "Name", description: "Your full name" },
        age: { type: "number", title: "Age" },
        subscribe: { type: "boolean", title: "Subscribe" },
        colour: { type: "string", title: "Colour", enum: ["red", "green"] },
      },
      ["name"],
    ),
    keys: ["\x1b"],
  },
  {
    name: "two",
    message: "Name two things",
    schema: object(
      { first: { type: "string", title: "First" }, second: { type: "string", title: "Second" } },
      ["first", "second"],
    ),
    keys: [{ submit: "one" }, { submit: "two" }],
  },
]

// Registers the probe's MCP server, its tools approved, as each harness takes one.
const register = (setup: AgentSetup, run: E2E, server: string, dir: string): void => {
  if (setup.agent === "codex") {
    const config = join(run.sandbox.home, ".codex", "config.toml")
    writeFileSync(
      config,
      `${readFileSync(config, "utf8")}\n[mcp_servers.probe]\ncommand = "node"\nargs = [${JSON.stringify(server)}]\nenv = { PROBE_DIR = ${JSON.stringify(dir)} }\ndefault_tools_approval_mode = "approve"\n`,
    )
    return
  }
  const home = join(run.sandbox.home, ".gemini", "antigravity-cli")
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, "mcp_config.json"),
    JSON.stringify({
      mcpServers: { probe: { command: "node", args: [server], env: { PROBE_DIR: dir } } },
    }),
  )
}

// The call of the probe server's `form` tool, by the name the harness offers it under.
const formCall = (call: Call, form: Form) => {
  const named = call.tools.find((name) => /probe.*form$/i.test(name))
  const input = { message: form.message, schema: form.schema }
  return named
    ? { calls: [{ name: named, input }] }
    : {
        calls: [
          {
            name: "call_mcp_tool",
            input: { ServerName: "probe", ToolName: "form", Arguments: JSON.stringify(input) },
          },
        ],
      }
}

const snap = async (t: DeckTerminal, columns: number): Promise<ScreenRecord> =>
  screenRecord((await t.screenText())!, { columns })

const records = (run: E2E): string[] =>
  [
    ...files(join(run.sandbox.home, ".codex", "sessions")),
    ...files(join(run.sandbox.home, ".gemini")).filter((path) => path.endsWith(".jsonl")),
  ].flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => /elicit|McpToolCall|probe/i.test(line))
      .map((line) => line.slice(0, 1500)),
  )

for (const setup of [codex, agy]) {
  for (const form of forms)
    describe.skipIf(!supported || !probing || !selected(setup))(
      `probe: ${setup.name}'s elicitation form, ${form.name}`,
      () => {
        const it = e2e(setup)
        it("captures", { timeout: 180_000 }, async ({ e2e: run }) => {
          const dir = join(run.sandbox.root, "probe")
          mkdirSync(dir, { recursive: true })
          const server = join(dir, "server.mjs")
          copyFileSync(join(import.meta.dirname, "elicit-probe-server.mjs"), server)
          register(setup, run, server, dir)
          const seen: { result?: string; offered?: string[] } = {}
          run.model.use(
            answers("Ask now", (call) => {
              seen.offered = call.tools.filter((name) => /probe|mcp/i.test(name))
              return formCall(call, form) as never
            }),
            own((call) => {
              const told = result(call)
              if (told === undefined) return undefined
              seen.result = told
              return { text: "Done." }
            }),
          )
          const t = await start(run, setup)
          await t.submit("Ask now")
          // Antigravity confirms the call first: that screen, then its Yes.
          const confirmation = await t
            .until(/Allow calling this tool\?/, 15_000)
            .then(async () => {
              await sleep(800)
              const shown = await snap(t, 120)
              t.press("1")
              return shown
            })
            .catch(() => undefined)
          // Whatever shows: the form, or nothing.
          await t.until(new RegExp(form.message.slice(0, 12)), 30_000).catch(() => undefined)
          await sleep(1200)
          const detail = await t.detail()
          const screens: Record<string, ScreenRecord> = {}
          for (const [cols, rows] of [
            [120, 40],
            [80, 24],
            [50, 20],
          ] as const) {
            t.resize(cols, rows)
            await sleep(900)
            screens[`${cols}x${rows}`] = await snap(t, cols)
          }
          t.resize(120, 40)
          await sleep(900)
          const steps: Record<string, ScreenRecord> = {}
          for (const [index, key] of form.keys.entries()) {
            if (typeof key === "string") t.press(key)
            else await t.submit(key.submit)
            await sleep(700)
            steps[`${index}:${JSON.stringify(key)}`] = await snap(t, 120)
          }
          await sleep(300)
          steps.at300ms = await snap(t, 120)
          await sleep(2500)
          steps.after = await snap(t, 120)
          const later = await t.detail()
          writeFileSync(
            join(out, `elicit-${setup.agent}-${form.name}.json`),
            JSON.stringify(
              {
                harness: setup.agent,
                form: form.name,
                schema: form.schema,
                keys: form.keys,
                offered: seen.offered,
                confirmation: confirmation ?? null,
                screens,
                steps,
                toolResult: seen.result ?? null,
                novadeckSees: { activity: detail.activity, requests: detail.requests },
                novadeckSeesAfter: { activity: later.activity, requests: later.requests },
                records: records(run),
                mcp: existsSync(join(dir, "mcp.jsonl"))
                  ? readFileSync(join(dir, "mcp.jsonl"), "utf8").split("\n").filter(Boolean)
                  : [],
              },
              null,
              2,
            ),
          )
        })
      },
    )
}
