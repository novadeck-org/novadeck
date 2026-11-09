// PROBE, not a regression test: Antigravity's ask_question with several questions where one
// is a multi-select, the shape its adapter doesn't read yet. For each order of the questions
// it presses the keys one at a time and saves the screen after each, and the answer the model
// was given, to <AGY_SEVERAL_OUT or tmp>/<case>.json.
// Run: NOVADECK_E2E_PROBES=1 NOVADECK_E2E_AGENTS=agy pnpm --filter @novadeck/runner exec \
//   vitest run --config vitest.e2e.config.ts src/e2e/probes/agy-several-questions.e2e.ts
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import type { Question } from "../agents/agent.js"
import { agy } from "../agents/agy.js"
import { describe, e2e, expect, supported } from "../fixture.js"
import { answers, own, result, start } from "../scenarios.js"
import { sleep } from "./support.js"

const out = process.env.AGY_SEVERAL_OUT ?? join(tmpdir(), "agy-several-probe")
mkdirSync(out, { recursive: true })

const colour: Question = {
  question: "Which color should the button be?",
  header: "Color",
  multiSelect: false,
  options: [
    { label: "Blue", description: "" },
    { label: "Green", description: "" },
  ],
}
const features: Question = {
  question: "Which features should be enabled?",
  header: "Features",
  multiSelect: true,
  options: [
    { label: "Auth", description: "" },
    { label: "Billing", description: "" },
    { label: "Search", description: "" },
  ],
}
const sizes: Question = {
  question: "Which sizes should it come in?",
  header: "Sizes",
  multiSelect: true,
  options: [
    { label: "Small", description: "" },
    { label: "Large", description: "" },
  ],
}

const Down = "\x1b[B"
const Esc = "\x1b"

// A step: keys pressed, or keys then Enter once the screen shows `then` (`confirm`).
type Step = readonly [name: string, keys: string, then?: RegExp]
const on = (label: string) => new RegExp(`\\[[^ \\]]\\] ${label}`)
const words = "Let's discuss this first: tell me about the footer"

// Each case: its questions, and the steps taken in turn, each with a name for its screen.
// `command` asks for a command's confirmation instead of the questions.
const cases: readonly {
  name: string
  questions: readonly Question[]
  steps: readonly Step[]
  command?: true
}[] = [
  {
    name: "single-multi-enter",
    questions: [colour, features],
    steps: [
      ["down-enter", Down, /> 2\. Green/],
      ["1", "1"],
      ["3-enter", "3", on("Search")],
    ],
  },
  {
    name: "multi-single-enter",
    questions: [features, colour],
    steps: [
      ["1", "1"],
      ["2-enter", "2", on("Billing")],
      ["down-enter", Down, /> 2\. Green/],
    ],
  },
  {
    name: "multi-single-right",
    questions: [features, colour],
    steps: [
      ["2", "2"],
      ["right", "\x1b[C"],
      ["down-enter", Down, /> 2\. Green/],
    ],
  },
  {
    name: "multi-multi",
    questions: [features, sizes],
    steps: [
      ["1-enter", "1", on("Auth")],
      ["2-enter", "2", on("Large")],
    ],
  },
  {
    name: "single-multi-writein-esc",
    questions: [colour, features],
    steps: [
      ["down", Down],
      ["down-enter", Down, /> 3\. Write-in/],
      ["type-enter", words, /footer/],
      ["esc", Esc],
    ],
  },
  {
    name: "multi-single-writein-esc",
    questions: [features, colour],
    steps: [
      ["down", Down],
      ["down", Down],
      ["down-enter", Down, /> 4\. Write-in/],
      ["type-enter", words, /footer/],
      ["esc", Esc],
    ],
  },
  {
    name: "multi-alone-writein",
    questions: [features],
    steps: [
      ["down", Down],
      ["down", Down],
      ["down-enter", Down, /> 4\. Write-in/],
      ["type-enter", words, /footer/],
    ],
  },
  {
    name: "command-esc",
    questions: [],
    command: true,
    steps: [["esc", Esc]],
  },
  {
    name: "multi-esc-esc",
    questions: [features, colour],
    steps: [
      ["esc", Esc],
      ["esc", Esc],
    ],
  },
]

describe.skipIf(!supported)("Antigravity several questions", () => {
  const it = e2e(agy)
  for (const each of cases)
    it(each.name, async ({ e2e: run }) => {
      run.model.use(
        answers("Ask me", (call) =>
          each.command ? agy.approval!.request(call) : agy.asking!.questions(call, each.questions),
        ),
        own((call) => (result(call) !== undefined ? { text: "Noted." } : undefined)),
      )
      const t1 = await start(run, agy)
      await t1.prompt("Ask me about the button")
      await t1.until(each.command ? agy.approval!.shows : /Question 1\/\d+:/, 60_000)
      await sleep(800)
      const screens: { after: string; rows: unknown; detail: unknown }[] = []
      const shot = async (after: string) => {
        const text = await t1.screenText()
        const detail = await t1.detail()
        screens.push({
          after,
          rows: text ? screenRecord(text) : null,
          detail: {
            activity: t1.summary().activity?.state ?? null,
            requests: detail.requests.map(({ dialog }) => dialog),
          },
        })
      }
      await shot("start")
      for (const [name, keys, then] of each.steps) {
        // eslint-disable-next-line no-await-in-loop -- Pressed in turn.
        if (then) await t1.confirm(then, async () => t1.press(keys))
        else t1.press(keys)
        // eslint-disable-next-line no-await-in-loop -- Pressed in turn.
        await sleep(1200)
        // eslint-disable-next-line no-await-in-loop -- As above.
        await shot(name)
      }
      await sleep(2000)
      const told = run.model.calls
        .filter((call) => !call.side)
        .map((call) => result(call))
        .filter((text) => text !== undefined)
      // Whether the turn went on: the model called again after the key, and what Novadeck says.
      const after = {
        calls: run.model.calls.filter((call) => !call.side).length,
        screen: await t1.screen(),
      }
      writeFileSync(
        join(out, `${each.name}.json`),
        JSON.stringify({ name: each.name, told, after, screens }, null, 2),
      )
      expect(screens.length).toBeGreaterThan(1)
    })
})
