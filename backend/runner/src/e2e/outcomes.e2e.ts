import type { ToolOutcome, TranscriptItem } from "@novadeck/protocol"

import { describe, e2e, expect, supported } from "./fixture.js"
import { setupOf, stepsIn, takeSteps, variants, type Expected } from "./outcomes.js"

// The tool outcomes each harness's decoder reads, the latest half: the fixtures replay what
// one version recorded, and this has each real harness take the steps and reads what the
// runner serves (`agents.transcript`). In the nightly `NOVADECK_E2E_HARNESS=latest` run it
// flags a release that changed a word they are read from, rather than a chat with wrong numbers.

type Row = { readonly call: TranscriptItem; readonly result: TranscriptItem | undefined }

// The calls among the items, each with its result; Claude Code's own loading of tools aside.
const rows = (items: readonly TranscriptItem[]): readonly Row[] =>
  items
    .filter((item) => item.kind === "tool-call" && item.tool !== "ToolSearch")
    .map((call) => ({
      call,
      result: items.find((item) => item.kind === "tool-result" && item.call === call.call),
    }))

// A call's outcome as a person would be told it: what its result says, over what its input said.
const told = ({ call, result }: Row): ToolOutcome => ({
  failed: null,
  exit: null,
  running: false,
  size: null,
  ...result?.outcome,
  change: result?.outcome?.change ?? call.outcome?.change ?? null,
})

const check = (row: Row, { added, removed, ...parts }: Expected, name: string) => {
  const outcome = told(row)
  expect(outcome, name).toMatchObject(parts)
  if (added !== undefined) expect(outcome.change?.added, name).toBe(added)
  if (removed !== undefined) expect(outcome.change?.removed, name).toBe(removed)
}

for (const variant of variants) {
  if (variant.steps(() => "").every((step) => !step.expected)) continue
  const setup = setupOf(variant)
  describe.skipIf(!supported)(`Tool outcomes: ${variant.name}`, () => {
    const it = e2e(setup)
    it("reads what came of each call", { timeout: 300_000 }, async ({ e2e: run }) => {
      variant.prepare(run)
      const steps = stepsIn(variant, run).filter((step) => step.expected)
      const terminal = await takeSteps(run, setup, steps)
      const all = rows(await terminal.transcript())
      const own = all.filter(({ call }) => !call.scripted)
      expect(own.map(({ call }) => call.tool).length).toBe(steps.length)
      steps.forEach((step, index) => {
        const row = own[index]!
        check(row, step.expected!, step.name)
        const { scripted } = step
        if (!scripted) return
        const from = all.indexOf(row)
        const next = own[index + 1]
        const nested = all.slice(from + 1, next ? all.indexOf(next) : undefined)
        expect(nested.length, `${step.name}'s calls`).toBe(scripted.length)
        nested.forEach((each, at) => check(each, scripted[at]!, `${step.name}'s call ${at}`))
      })
    })
  })
}
