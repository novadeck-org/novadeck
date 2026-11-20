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

// The sizes a dialog is shot at: wide down to narrower than any split pane.
const sizes = [
  [120, 40],
  [80, 24],
  [64, 24],
  [50, 20],
  [40, 20],
] as const

// Each size's screen of what shows now, back at 120 columns after.
const shots = async (t: DeckTerminal): Promise<Record<string, ScreenRecord>> => {
  const screens: Record<string, ScreenRecord> = {}
  for (const [cols, rows] of sizes) {
    t.resize(cols, rows)
    await sleep(900)
    screens[`${cols}x${rows}`] = await snap(t, cols)
  }
  t.resize(120, 40)
  await sleep(900)
  return screens
}

// Codex's approval of an MCP tool's call, which is drawn as a form too: a third-party server's
// tool with long names, and Codex's own `codex_tui` tool, at each size. It has a hook of its
// own (PermissionRequest), so the request Novadeck should see is that one alone.
const approvals = [
  {
    name: "long-names",
    server: "my-company-tools",
    tool: /my.company.tools.*create_pull_request_review_comment$/,
    input: { body: "Looks good to me" },
  },
  {
    name: "codex-tui",
    server: null,
    tool: /codex_tui.*send_message_to_thread$/,
    input: { thread_id: "019a0000-0000-7000-8000-000000000001", message: "hi" },
  },
] as const

describe.skipIf(!supported || !probing || !selected(codex))(
  "probe: Codex's MCP tool approvals, beside its elicitation forms",
  () => {
    const it = e2e(codex)
    for (const approval of approvals)
      it(`captures ${approval.name}`, { timeout: 180_000 }, async ({ e2e: run }) => {
        const dir = join(run.sandbox.root, "probe")
        mkdirSync(dir, { recursive: true })
        const server = join(dir, "server.mjs")
        copyFileSync(join(import.meta.dirname, "elicit-probe-server.mjs"), server)
        if (approval.server !== null) {
          const config = join(run.sandbox.home, ".codex", "config.toml")
          writeFileSync(
            config,
            `${readFileSync(config, "utf8")}\n[mcp_servers.${approval.server}]\ncommand = "node"\nargs = [${JSON.stringify(server)}]\nenv = { PROBE_DIR = ${JSON.stringify(dir)} }\ndefault_tools_approval_mode = "prompt"\n`,
          )
        }
        const seen: { offered?: string[]; called?: string | undefined } = {}
        run.model.use(
          answers("Ask now", (call) => {
            seen.offered = call.tools.filter((name) => /mcp/i.test(name))
            const named = call.tools.find((name) => approval.tool.test(name))
            seen.called = named
            return (
              named
                ? { calls: [{ name: named, input: approval.input }] }
                : { text: "No such tool." }
            ) as never
          }),
          own((call) => (result(call) === undefined ? undefined : { text: "Done." })),
        )
        const t = await start(run, codex)
        await t.submit("Ask now")
        await t.until(/Field 1\/1|run tool/, 30_000).catch(() => undefined)
        await sleep(1200)
        const detail = await t.detail()
        const screens = await shots(t)
        t.press("\x1b")
        await sleep(2500)
        const after = await snap(t, 120)
        writeFileSync(
          join(out, `approval-codex-${approval.name}.json`),
          JSON.stringify(
            {
              offered: seen.offered,
              called: seen.called ?? null,
              input: approval.input,
              screens,
              after,
              novadeckSees: { activity: detail.activity, requests: detail.requests },
            },
            null,
            2,
          ),
        )
      })
  },
)

// A spawned agent's elicitation: whose screen draws it, and whose request it is.
describe.skipIf(!supported || !probing || !selected(codex))(
  "probe: a Codex subagent's elicitation form",
  () => {
    const it = e2e(codex)
    it("captures", { timeout: 180_000 }, async ({ e2e: run }) => {
      const dir = join(run.sandbox.root, "probe")
      mkdirSync(dir, { recursive: true })
      const server = join(dir, "server.mjs")
      copyFileSync(join(import.meta.dirname, "elicit-probe-server.mjs"), server)
      register(codex, run, server, dir)
      const form = forms[0]!
      const task = "Helper task: ask the server"
      const owns = (call: Call) =>
        !call.side && call.turns.some((one) => one.role === "user" && one.text.includes(task))
      const seen: { result?: string } = {}
      run.model.use(
        own((call) => {
          if (!owns(call)) return undefined
          const told = result(call)
          if (told !== undefined) {
            seen.result = told
            return { text: "Helper done." }
          }
          return formCall(call, form) as never
        }),
        own((call) => {
          const spawn = call.tools.find((offered) => offered.endsWith("spawn_agent"))
          if (
            !spawn ||
            !call.turns.some((one) => one.role === "user" && one.text.includes("Spawn a helper"))
          )
            return undefined
          if (result(call)?.includes('"agent_id"')) return { text: "Spawned it." }
          return { calls: [{ name: spawn, input: { message: task } }] }
        }),
      )
      const t = await start(run, codex)
      await t.submit("Spawn a helper")
      const shown = await t
        .until(new RegExp(form.message.slice(0, 12)), 40_000)
        .then(() => true)
        .catch(() => false)
      await sleep(2500)
      const during = await t.detail()
      const screens = await shots(t)
      // Waits as the root's turn may end meanwhile, then looks again.
      await sleep(4000)
      const later = await t.detail()
      t.press("2")
      await sleep(3000)
      const after = await snap(t, 120)
      const done = await t.detail()
      writeFileSync(
        join(out, "elicit-codex-subagent.json"),
        JSON.stringify(
          {
            shown,
            screens,
            after,
            toolResult: seen.result ?? null,
            novadeckSees: { activity: during.activity, requests: during.requests },
            novadeckSeesLater: { activity: later.activity, requests: later.requests },
            novadeckSeesAfter: { activity: done.activity, requests: done.requests },
            records: records(run),
          },
          null,
          2,
        ),
      )
    })
  },
)

// The same while the root works on: its turn ends with the form still up.
describe.skipIf(!supported || !probing || !selected(codex))(
  "probe: a Codex subagent's elicitation form, the root's turn ending under it",
  () => {
    const it = e2e(codex)
    it("captures", { timeout: 180_000 }, async ({ e2e: run }) => {
      const dir = join(run.sandbox.root, "probe")
      mkdirSync(dir, { recursive: true })
      const server = join(dir, "server.mjs")
      copyFileSync(join(import.meta.dirname, "elicit-probe-server.mjs"), server)
      register(codex, run, server, dir)
      const form = forms[0]!
      const task = "Helper task: ask the server"
      const owns = (call: Call) =>
        !call.side && call.turns.some((one) => one.role === "user" && one.text.includes(task))
      const root = (call: Call) =>
        !call.side &&
        call.turns.some((one) => one.role === "user" && one.text.includes("Spawn a helper"))
      run.model.use(
        own((call) => {
          if (!owns(call)) return undefined
          return result(call) === undefined
            ? (formCall(call, form) as never)
            : { text: "Helper done." }
        }),
        own((call) => {
          if (!root(call)) return undefined
          const spawn = call.tools.find((offered) => offered.endsWith("spawn_agent"))
          const told = result(call)
          if (told === undefined && spawn)
            return { calls: [{ name: spawn, input: { message: task } }] }
          if (told?.includes('"agent_id"'))
            return {
              calls: [{ name: "exec_command", input: { cmd: "sleep 8", yield_time_ms: 30_000 } }],
            }
          return { text: "Root done." }
        }),
      )
      const t = await start(run, codex)
      await t.submit("Spawn a helper")
      await t.until(new RegExp(form.message.slice(0, 12)), 40_000).catch(() => undefined)
      const timeline: unknown[] = []
      for (let second = 0; second < 16; second += 1) {
        const detail = await t.detail()
        timeline.push({
          second,
          state: detail.activity?.state,
          requests: detail.requests.map(({ ref, tool, subject }) => ({ ref, tool, subject })),
        })
        await sleep(1000)
      }
      const shown = await snap(t, 120)
      t.press("2")
      await sleep(3000)
      const done = await t.detail()
      writeFileSync(
        join(out, "elicit-codex-subagent-root-ends.json"),
        JSON.stringify(
          {
            timeline,
            shown,
            after: await snap(t, 120),
            novadeckSeesAfter: { activity: done.activity, requests: done.requests },
          },
          null,
          2,
        ),
      )
    })
  },
)
