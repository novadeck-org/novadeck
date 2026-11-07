// PROBE, not a test of Novadeck: what each harness's box reads as where a ring's line, or a
// person's draft, holds what the reader may take for something else: the words of a view's footer,
// a row of `─`, or words under blank rows with the cursor moved up above them; and, beside those,
// the views themselves whose footers those words are. Each scenario gets a terminal of its own.
// Runs only with NOVADECK_E2E_PROBES=1, by path; PROBE_ONLY (a regular expression) picks scenarios
// by name. Writes $PROBE_OUT/ring-reading-<agent>.json, each step a `ScreenRecord` with the box
// as the adapter reads it. The adapters' fixtures (harnesses/*/src/fixtures/ring-reading.probe.json)
// are a choice of those screens.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { ScreenText } from "@novadeck/emulator/headless"
import { replyLine } from "@novadeck/harness-core/prompts"
import { screenRecord } from "@novadeck/harness-core/testing/probes"
import { isEmpty } from "@novadeck/tui-input/box"

import { harnesses } from "../../harnesses/registry.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { replies, start, turn } from "../scenarios.js"
import { paste, probing, sleep } from "./support.js"

const up = "\x1b[A"
const left = "\x1b[D"
const ctrlO = "\x0f"
const ctrlR = "\x12"
const esc = "\x1b"
const enter = "\r"

/** A reply line as the doorbell types it, saying `words`. */
const reply = (words: string): string =>
  replyLine([{ subject: "Merge the branch?", text: words }])!("n7Q2kx")

// What each harness's views say in their footers (the box profiles' `overlay`).
const phrases = [
  "Showing detailed transcript of it",
  "enter to return · space to reply",
  "Esc to cancel · ctrl+s to scope",
  "reverse-i-search: merge",
  "? / esc close",
  "Side from main thread · ctrl+/ to switch",
  "enter to create · esc to clear",
  "then merge it · esc back",
  "Keyboard: ctrl+k esc Close",
]

type Step =
  | { readonly label: string; readonly keys: string; readonly wait?: number }
  | { readonly label: string; readonly paste: string; readonly wait?: number }
  | { readonly label: string; readonly resize: readonly [number, number] }

type Scenario = {
  readonly name: string
  readonly agents?: readonly string[]
  readonly steps: (agent: string) => readonly Step[]
}

const erase: Step = { label: "erase", keys: `${"\x15\x7f".repeat(24)}\x15`, wait: 1200 }
const sizes = [
  [80, 24],
  [40, 12],
  [40, 14],
  [80, 12],
  [120, 24],
] as const

/** A line break typed as a key: Antigravity takes Escape Enter for one. */
const lineBreak = (agent: string) => (agent === "agy" ? "\x1b\r" : "\n")

const scenarios: readonly Scenario[] = [
  // Each view's footer in a reply line, at each size, the line erased between.
  ...sizes.map(([columns, rows]): Scenario => ({
    name: `words ${columns}x${rows}`,
    steps: () => [
      { label: "size", resize: [columns, rows] },
      ...phrases.flatMap((words): Step[] => [{ label: words, paste: reply(words) }, erase]),
    ],
  })),
  // "Keyboard:" led by fill enough to start a row with it, which Antigravity's check anchors to.
  ...([40, 80] as const).map((columns): Scenario => ({
    name: `keyboard at a row's start ${columns}`,
    steps: () => [
      { label: "size", resize: [columns, 14] },
      ...Array.from({ length: 12 }, (_, at): Step[] => [
        {
          label: `fill ${at}`,
          paste: reply(`${"x".repeat(at)} ${"y".repeat(columns - 30)} Keyboard: ctrl+k esc Close`),
        },
        erase,
      ]).flat(),
    ],
  })),
  // A row of `─` in a reply, and in a draft of lines, the cursor below it and above it.
  ...(
    [
      [40, 14],
      [80, 12],
      [120, 24],
    ] as const
  ).map(([columns, rows]): Scenario => ({
    name: `rule ${columns}x${rows}`,
    steps: (agent) => [
      { label: "size", resize: [columns, rows] },
      { label: "reply", paste: reply(`see ${"─".repeat(Math.min(columns * 2, 160))} merge it`) },
      erase,
      { label: "draft", paste: `first line\n${"─".repeat(30)}\nlast line` },
      { label: "up 1", keys: up },
      { label: "up 2", keys: up },
      { label: "erase", keys: `\x1b[F${"\x1b[B".repeat(3)}`, wait: 400 },
      erase,
      { label: "typed rule", keys: `top${lineBreak(agent)}${"─".repeat(20)}`, wait: 1500 },
    ],
  })),
  // Words under blank rows, the cursor moved up over them to the box's first row, a key at a time.
  ...(
    [
      [80, 12],
      [80, 14],
      [80, 24],
    ] as const
  ).flatMap(([columns, rows]): Scenario[] =>
    [1, 2, 3, 4, 5, 12].map((blanks): Scenario => ({
      name: `blanks ${blanks} ${columns}x${rows}`,
      steps: (agent) => [
        { label: "size", resize: [columns, rows] },
        ...Array.from({ length: blanks }, (): Step => ({
          label: "line break",
          keys: lineBreak(agent),
          wait: 300,
        })),
        { label: "draft", keys: "MY DRAFT BELOW", wait: 800 },
        ...Array.from({ length: blanks }, (_, at): Step => ({
          label: `up ${at + 1}`,
          keys: up,
          wait: 500,
        })),
      ],
    })),
  ),
  // The views themselves, empty and with words in them, at two sizes.
  ...(
    [
      [80, 24],
      [40, 12],
    ] as const
  ).flatMap(([columns, rows]): Scenario[] => [
    {
      name: `claude views ${columns}x${rows}`,
      agents: ["claude"],
      steps: () => [
        { label: "size", resize: [columns, rows] },
        { label: "transcript", keys: ctrlO, wait: 1500 },
        { label: "transcript closed", keys: ctrlO, wait: 1500 },
        { label: "history search", keys: ctrlR, wait: 1500 },
        { label: "history search typed", keys: "Warm", wait: 1500 },
        { label: "history search closed", keys: esc, wait: 1500 },
        { label: "agents view", keys: left, wait: 2000 },
        { label: "agents view typed", paste: "and merge it" },
        { label: "agents view cleared", keys: esc, wait: 1500 },
        { label: "agents view closed", keys: esc, wait: 1500 },
      ],
    },
    {
      name: `codex views ${columns}x${rows}`,
      agents: ["codex"],
      steps: () => [
        { label: "size", resize: [columns, rows] },
        { label: "history search", keys: ctrlR, wait: 1500 },
        { label: "history search typed", keys: "Warm", wait: 1500 },
        { label: "history search closed", keys: esc, wait: 1500 },
        { label: "shortcuts", keys: "?", wait: 1500 },
        { label: "shortcuts closed", keys: esc, wait: 1500 },
        { label: "side typed", keys: "/side", wait: 1500 },
        { label: "side", keys: enter, wait: 3000 },
      ],
    },
    {
      name: `agy views ${columns}x${rows}`,
      agents: ["agy"],
      steps: () => [
        { label: "size", resize: [columns, rows] },
        { label: "shortcuts", keys: "?", wait: 1500 },
        { label: "shortcuts closed", keys: esc, wait: 1500 },
        { label: "artifacts", keys: ctrlR, wait: 1500 },
        { label: "artifacts closed", keys: esc, wait: 1500 },
      ],
    },
  ]),
]

/** The keys in plain form: a line of `\xNN`s reads better in the record than raw controls. */
const shown = (keys: string): string =>
  // eslint-disable-next-line no-control-regex -- Control characters are what it shows.
  keys.replace(/[\x00-\x1f\x7f]/g, (key) => `\\x${key.charCodeAt(0).toString(16).padStart(2, "0")}`)

const only = process.env.PROBE_ONLY ? new RegExp(process.env.PROBE_ONLY) : undefined
const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: ring reading in ${setup.name}`, () => {
    const it = e2e(setup)
    const profile = harnesses[setup.agent].box!

    for (const scenario of scenarios.filter(({ name }) => only?.test(name) ?? true)) {
      it(scenario.name, { timeout: 600_000 }, async ({ e2e: run, skip }) => {
        if (scenario.agents && !scenario.agents.includes(setup.agent)) skip()
        run.model.use(replies("Warm up", "Warmed up."), () => ({ text: "Noted." }))
        const t = await start(run, setup)
        await turn(t, "Warm up", "Warmed up.")
        const record: unknown[] = []
        const look = async (label: string, keys?: string) => {
          await t.settled().catch(() => undefined)
          const screen: ScreenText | undefined = await t.screenText()
          const read = screen && profile.read(screen)
          record.push({
            label,
            ...(keys !== undefined && { keys: shown(keys) }),
            box: read ?? null,
            empty: read ? isEmpty(read) : null,
            overlay: screen ? profile.overlay(screen) : null,
            screen: screen ? screenRecord(screen) : null,
          })
        }
        for (const step of scenario.steps(setup.agent)) {
          if ("resize" in step) {
            t.resize(...step.resize)
            await sleep(1500)
            await look(step.label)
            continue
          }
          const keys = "keys" in step ? step.keys : paste(step.paste)
          // Written as they are: `press` refuses an Enter, which a line break or `/side` needs.
          run.deck.terminals.write({ terminalId: t.id, data: keys }, "e2e")
          await sleep(step.wait ?? 1000)
          await look(step.label, "keys" in step ? keys : undefined)
        }
        mkdirSync(outDir, { recursive: true })
        const path = join(outDir, `ring-reading-${setup.agent}.json`)
        const out = existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
          : {}
        out[scenario.name] = record
        writeFileSync(path, JSON.stringify(out, null, 2))
      })
    }
  })
}
