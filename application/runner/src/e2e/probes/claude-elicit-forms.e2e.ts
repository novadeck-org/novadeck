// MCP elicitation forms: how Claude Code draws each field type and which keys fill them.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { dialogs } from "../../harnesses/claude/dialogs.js"
import { claude } from "../agents/claude.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, supported } from "../fixture.js"
import { answers, own, result } from "../scenarios.js"
import { capture, install, sleep, snap, tweak } from "./claude-support.js"

const here = import.meta.dirname
const Down = "\x1b[B"
const Up = "\x1b[A"
const Right = "\x1b[C"
const Left = "\x1b[D"

type Drive = (
  t: DeckTerminal,
  shot: (label: string, wait?: number) => Promise<void>,
) => Promise<void>
const form = (name: string, message: string, schema: object, drive?: Drive) =>
  describe.skipIf(!supported)(`claude elicitation form: ${name}`, () => {
    const it = e2e(claude)
    it("captures", async ({ e2e: run }) => {
      const probe = install(run)
      const server = join(probe.dir, "server.mjs")
      copyFileSync(join(here, "claude-mcp-server.mjs"), server)
      writeFileSync(
        join(run.sandbox.project, ".mcp.json"),
        JSON.stringify({
          mcpServers: { probe: { command: "node", args: [server], env: { PROBE_DIR: probe.dir } } },
        }),
      )
      tweak(run, (s) => {
        s.enableAllProjectMcpServers = true
        s.permissions.allow.push("mcp__probe")
      })
      const seen: { result?: string } = {}
      run.model.use(
        answers("Ask now", () => ({
          calls: [{ name: "mcp__probe__form", input: { message, schema } }] as never,
        })),
        own((c) => {
          const r = result(c)
          if (r === undefined) return undefined
          seen.result = r
          return { text: "Done." }
        }),
      )
      const t = await run.deck.open("claude")
      await sleep(8000)
      await t.submit("Ask now")
      await t.until(new RegExp(message.slice(0, 12)), 30_000)
      await sleep(900)
      const screens: Record<string, string[]> = { "120x40": await snap(t) }
      t.resize(60, 20)
      await sleep(900)
      screens["60x20"] = await snap(t)
      t.resize(120, 40)
      await sleep(900)
      const steps: Record<string, string[]> = {}
      const shot = async (label: string, wait = 700) => {
        await sleep(wait)
        steps[label] = await snap(t)
      }
      if (drive) await drive(t, shot)
      await sleep(1500)
      steps.after = await snap(t)
      capture(`form-${name}`, {
        screens,
        steps,
        toolResult: seen.result,
        hooks: probe.log(),
        mcp: existsSync(join(probe.dir, "mcp.jsonl"))
          ? readFileSync(join(probe.dir, "mcp.jsonl"), "utf8")
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l))
          : [],
      })
    })
  })

const object = (properties: object, required: string[] = []) => ({
  type: "object",
  properties,
  required,
})
form("text", "What is your name?", object({ name: { type: "string", title: "Name" } }, ["name"]))
form(
  "two",
  "Tell us about yourself",
  object(
    {
      name: { type: "string", title: "Name", description: "Your full name" },
      nick: { type: "string", title: "Nickname" },
    },
    ["name"],
  ),
)
form("number", "How many?", object({ count: { type: "number", title: "Count" } }, ["count"]))
form("boolean", "Subscribe?", object({ sub: { type: "boolean", title: "Subscribe" } }, ["sub"]))
form(
  "enum",
  "Pick a colour",
  object({ colour: { type: "string", title: "Colour", enum: ["red", "green", "blue"] } }, [
    "colour",
  ]),
)
form(
  "mixed",
  "Everything at once",
  object(
    {
      name: { type: "string", title: "Name" },
      age: { type: "number", title: "Age" },
      ok: { type: "boolean", title: "Agree" },
      colour: { type: "string", title: "Colour", enum: ["red", "green"] },
    },
    ["name"],
  ),
)

// Keys: what moves between fields, fills them and gets to Accept and Decline.
form(
  "keys-two",
  "Tell us about yourself",
  object({ name: { type: "string", title: "Name" }, nick: { type: "string", title: "Nickname" } }, [
    "name",
  ]),
  async (t, shot) => {
    t.press("Ada")
    await shot("typed-name", 800)
    t.press(Down)
    await shot("down-1", 800)
    t.press("Ace")
    await shot("typed-nick", 800)
    t.press(Down)
    await shot("down-2", 800)
    t.press(Right)
    await shot("right-on-buttons", 800)
    t.press(Left)
    await shot("left-on-buttons", 800)
    t.press(Up)
    await shot("up-from-buttons", 800)
  },
)
form(
  "keys-bool-enum",
  "Everything at once",
  object(
    {
      ok: { type: "boolean", title: "Agree" },
      colour: { type: "string", title: "Colour", enum: ["red", "green"] },
      n: { type: "number", title: "Count" },
    },
    [],
  ),
  async (t, shot) => {
    t.press(" ")
    await shot("space-1", 800)
    t.press(" ")
    await shot("space-2", 800)
    t.press(Down)
    await shot("on-enum", 800)
    t.press(Right)
    await shot("expanded", 800)
    t.press(Down)
    await shot("expanded-down", 800)
    t.press(Left)
    await shot("collapsed", 800)
    t.press(Down)
    await shot("on-number", 800)
    t.press("42")
    await shot("typed-number", 800)
    t.press("x")
    await shot("typed-x", 800)
  },
)

const everything = object(
  {
    name: { type: "string", title: "Name" },
    age: { type: "number", title: "Age" },
    ok: { type: "boolean", title: "Agree" },
    colour: { type: "string", title: "Colour", enum: ["red", "green"] },
  },
  ["name"],
)
form("accept-all", "Everything at once", everything, async (t, shot) => {
  t.press("Ada")
  await sleep(300)
  t.press(Down)
  await sleep(300)
  t.press("30")
  await sleep(300)
  t.press(Down)
  await sleep(300)
  t.press(" ")
  await sleep(300)
  t.press(Down)
  await sleep(300)
  t.press(Right)
  await sleep(300)
  t.press(Down)
  await sleep(300)
  t.press(" ")
  await shot("filled-expanded", 800)
  t.press(Left)
  await shot("filled", 800)
  await t.confirm(/❯ Accept/, async () => t.press(Down))
  await shot("submitted", 1500)
})
form(
  "decline",
  "What is your name?",
  object({ name: { type: "string", title: "Name" } }, ["name"]),
  async (t, shot) => {
    t.press(Down)
    await sleep(300)
    await shot("on-accept", 600)
    await t.confirm(/Accept {2}❯ Decline/, async () => t.press(Right))
    await shot("declined", 1500)
  },
)
form(
  "accept-missing",
  "What is your name?",
  object({ name: { type: "string", title: "Name" } }, ["name"]),
  async (t, shot) => {
    await t.confirm(/❯ Accept/, async () => t.press(Down))
    await shot("enter-on-accept", 1500)
  },
)
form(
  "required-bool",
  "Subscribe?",
  object(
    { sub: { type: "boolean", title: "Subscribe" }, opt: { type: "boolean", title: "Optional" } },
    ["sub"],
  ),
  async (t, shot) => {
    t.press(" ")
    await shot("space-1", 700)
    t.press(" ")
    await shot("space-2", 700)
    t.press(Down)
    t.press(" ")
    await shot("optional-space-1", 700)
    t.press("\x7f")
    await shot("optional-backspace", 700)
  },
)
form(
  "accept-text",
  "What is your name?",
  object({ name: { type: "string", title: "Name" } }, ["name"]),
  async (t, shot) => {
    t.press("Ada")
    await sleep(500)
    await t.confirm(/❯ Accept {4}Decline/, async () => {
      t.press(Down)
      await sleep(1200)
    })
    await shot("submitted", 2000)
  },
)
form(
  "accept-mixed-small",
  "Pick",
  object(
    {
      ok: { type: "boolean", title: "Agree" },
      colour: { type: "string", title: "Colour", enum: ["red", "green"] },
    },
    [],
  ),
  async (t, shot) => {
    t.press(" ")
    await sleep(300)
    t.press(Down)
    await sleep(300)
    t.press(Right)
    await sleep(300)
    t.press(Down)
    await sleep(300)
    t.press(" ")
    await sleep(300)
    t.press(Left)
    await sleep(300)
    await t.confirm(/❯ Accept {4}Decline/, async () => {
      t.press(Down)
      await sleep(1200)
    })
    await shot("submitted", 2000)
  },
)

// Initial layouts of fields that follow another, and of a leading optional boolean.
form(
  "layout-a",
  "Several fields",
  object(
    {
      name: { type: "string", title: "Name" },
      n: { type: "number", title: "Count" },
      e: { type: "string", title: "Colour", enum: ["red", "green"] },
      b: { type: "boolean", title: "Agree" },
      ob: { type: "boolean", title: "Maybe" },
    },
    ["name", "n", "e", "b"],
  ),
)
form(
  "layout-b",
  "Optional boolean first",
  object({ ob: { type: "boolean", title: "Maybe" }, name: { type: "string", title: "Name" } }, [
    "name",
  ]),
)
form(
  "layout-long",
  "A long message that has to wrap onto a second line because it keeps going and going for a while, longer than sixty columns",
  object(
    {
      name: {
        type: "string",
        title: "A long title for the field that wraps maybe",
        description:
          "A long description that goes past sixty columns for sure, to see how it wraps",
      },
    },
    ["name"],
  ),
)

// Words sent as one bracketed paste, as the runner's driver types them.
form(
  "paste",
  "Tell us about yourself",
  object({ name: { type: "string", title: "Name" }, n: { type: "number", title: "Count" } }, [
    "name",
  ]),
  async (t, shot) => {
    t.press("\x1b[200~Ada Lovelace\x1b[201~")
    await shot("pasted-name", 900)
    t.press(Down)
    await sleep(600)
    t.press("\x1b[200~42\x1b[201~")
    await shot("pasted-number", 900)
  },
)

// Descriptions on two fields: whether one stays once its field loses the highlight.
form(
  "described",
  "Two described fields",
  object(
    {
      name: { type: "string", title: "Name", description: "Your full name" },
      nick: { type: "string", title: "Nickname", description: "What friends call you" },
    },
    ["name"],
  ),
  async (t, shot) => {
    t.press("Ada")
    await shot("typed-name", 900)
    t.press(Down)
    await shot("down-1", 900)
    t.press("Ace")
    await shot("typed-nick", 900)
    t.press(Down)
    await shot("down-2", 900)
  },
)

// The adapter's own steps, run against the live form: read it, plan the answer, press the
// steps as the runner's driver does (words as one paste), and let the server say what it got.
const answered = (name: string, message: string, schema: object, values: object) =>
  form(name, message, schema, async (t, shot) => {
    const facts = {
      kind: "question" as const,
      tool: "mcp__probe__elicitation",
      input: { mcp_server_name: "probe", message, mode: "form", requested_schema: schema },
      cwd: null,
    }
    const read = dialogs.read((await t.screen()).split("\n"), facts)
    if (!read) throw new Error("the adapter does not read this form")
    const steps = read.keys({ type: "form", dialog: "d", action: "accept", values } as never)
    if (!steps) throw new Error("the adapter plans no keys for it")
    const waitFor = async (step: {
      until: (rows: readonly string[]) => boolean
      timeoutMs: number
      why: string
    }) => {
      const stop = Date.now() + step.timeoutMs
      while (Date.now() < stop) {
        // eslint-disable-next-line no-await-in-loop -- Polled in turn.
        if (step.until((await t.screen()).split("\n"))) return
        // eslint-disable-next-line no-await-in-loop -- As above.
        await sleep(50)
      }
      throw new Error(`timed out waiting for ${step.why}`)
    }
    for (let at = 0; at < steps.length; at++) {
      const step = steps[at]!
      if ("until" in step) {
        // eslint-disable-next-line no-await-in-loop -- The steps go in turn.
        await waitFor(step)
      } else if ("type" in step) {
        t.press(`\x1b[200~${step.type}\x1b[201~`)
      } else if (
        steps[at + 2] &&
        "press" in steps[at + 2]! &&
        (steps[at + 2] as { press: string }).press === "\r"
      ) {
        // The move onto Accept, and its Enter once the screen shows it.
        const wait = steps[at + 1] as Parameters<typeof waitFor>[0]
        // eslint-disable-next-line no-await-in-loop -- The steps go in turn.
        await t.confirm(/❯ Accept {4}Decline/, async () => {
          t.press(step.press)
          await waitFor(wait)
        })
        at += 2
      } else t.press(step.press)
    }
    await shot("submitted", 2000)
  })
answered(
  "adapter-described",
  "Two described fields",
  object(
    {
      name: { type: "string", title: "Name", description: "Your full name" },
      nick: { type: "string", title: "Nickname", description: "What friends call you" },
      ok: { type: "boolean", title: "Agree", description: "Terms" },
    },
    ["name"],
  ),
  { name: "Ada Lovelace", nick: "Ace", ok: true },
)
