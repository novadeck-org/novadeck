// PROBE, not a test of Novadeck: how each harness writes the person's prompt into its
// transcript, for prompts of several shapes given two ways: through Novadeck's own prompt
// path (`agents.prompt`, a bracketed paste and Enter) and as raw keys in the terminal, typed
// text around a bracketed paste. It records the raw user records the harness wrote for each,
// so the decoders know which wrappers (`<pasted_content>` and the like) a harness puts
// around the person's words, and when. Runs only with NOVADECK_E2E_PROBES=1, by path; writes
// $PROBE_OUT/<agent>-user-wrappers-<pin|latest>.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the turn before ends. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { start } from "../scenarios.js"
import { paste, probing, sleep } from "./support.js"

const lines = (marker: string, n: number) =>
  [marker, ...Array.from({ length: n - 1 }, (_, i) => `line ${i + 2} of the prompt`)].join("\n")
const long = (marker: string, n: number) =>
  `${marker} ${"words ".repeat(Math.ceil(n / 6))}`.slice(0, n)

type Shape = {
  readonly name: string
  // Through `agents.prompt` (the chat's path), or as raw keys: typed `before`, the paste,
  // typed `after`, then Enter.
  readonly via: "prompt" | "keys"
  readonly text: string
  readonly before?: string
  readonly after?: string
}

const shapes: readonly Shape[] = [
  { name: "short", via: "prompt", text: "wrap-a short prompt" },
  { name: "3 lines", via: "prompt", text: lines("wrap-b", 3) },
  { name: "12 lines", via: "prompt", text: lines("wrap-c", 12) },
  { name: "40 lines", via: "prompt", text: lines("wrap-d", 40) },
  { name: "one line of 900 chars", via: "prompt", text: long("wrap-e", 900) },
  { name: "one line of 2000 chars", via: "prompt", text: long("wrap-f", 2000) },
  { name: "keys: 3-line paste alone", via: "keys", text: lines("wrap-g", 3) },
  {
    name: "keys: typed around a 3-line paste",
    via: "keys",
    before: "wrap-h before ",
    text: lines("pasted", 3),
    after: " after",
  },
  {
    name: "keys: typed around a 20-line paste",
    via: "keys",
    before: "wrap-i before ",
    text: lines("pasted", 20),
    after: " after",
  },
  {
    name: "keys: typed around a 900-char paste",
    via: "keys",
    before: "wrap-j before ",
    text: long("pasted", 900),
    after: " after",
  },
  { name: "keys: two pastes", via: "keys", before: "wrap-k ", text: lines("first", 12) },
]

// Each shape's marker, which the record of its prompt holds.
const markerOf = (shape: Shape): string => (shape.before ?? shape.text).split(/\s/, 1)[0]!

// The files each harness keeps its transcripts in, under the sandbox's home.
const stores: Readonly<Record<AgentName, readonly string[]>> = {
  claude: [".claude/projects"],
  codex: [".codex/sessions"],
  agy: [".gemini/antigravity-cli/brain"],
}

const jsonl = (folder: string): string[] => {
  try {
    return readdirSync(folder, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(folder, name))
  } catch {
    return []
  }
}

// Every record holding `marker` in any transcript of the harness, parsed.
const records = (home: string, agent: AgentName, marker: string): unknown[] =>
  stores[agent]
    .flatMap((store) => jsonl(join(home, store)))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.includes(marker))
        .map((line) => {
          try {
            return { file: file.slice(home.length), record: JSON.parse(line) as unknown }
          } catch {
            return { file: file.slice(home.length), unparsed: line.slice(0, 400) }
          }
        }),
    )

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: user wrappers in ${setup.name}`, () => {
    const it = e2e(setup)
    it("each shape", async ({ e2e: run }) => {
      run.model.use((call) => (!call.side ? { text: "Noted." } : undefined))
      const out: Record<string, unknown> = { harness: setup.agent }
      const t = await start(run, setup)
      const write = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
      for (const shape of shapes) {
        const marker = markerOf(shape)
        const calls = run.model.mark()
        try {
          if (shape.via === "prompt") await t.prompt(shape.text)
          else {
            if (shape.before) write(shape.before)
            await sleep(400)
            write(paste(shape.text))
            await sleep(600)
            if (shape.name === "keys: two pastes") {
              write(" and ")
              await sleep(300)
              write(paste(lines("second", 4)))
              await sleep(600)
            }
            if (shape.after) write(shape.after)
            await sleep(600)
            out[`${shape.name} (box)`] = (await t.screen()).split("\n").slice(-12)
            write("\r")
          }
          await run.model.waitFor((call) => !call.side, { after: calls, timeoutMs: 60_000 })
          await t.until("Noted.")
          await sleep(1500)
          out[shape.name] = {
            given: shape,
            records: records(run.sandbox.home, setup.agent, marker),
          }
        } catch (error) {
          out[shape.name] = { given: shape, failed: String(error) }
          write("\x1b")
          await sleep(1000)
        }
        // A fresh line in the history between shapes, so each one's records stand apart.
        await sleep(500)
      }
      const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, `${setup.agent}-user-wrappers-${process.env.NOVADECK_E2E_HARNESS ?? "pin"}.json`),
        JSON.stringify(out, null, 1),
      )
    })
  })
}
