import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { readScreen } from "@novadeck/emulator/headless"

import { Terminals } from "../terminals/manager.js"
import { describe, expect, it } from "../test.js"
import { ptyOptions } from "../testing/pty.js"
import type { Resources } from "../testing/resources.js"

// Some e2e tests and probes reach into the runner's `Terminals` through a cast, for what
// nothing a person does can reach: typecheck can't see past it, and CI leaves the probes out
// (docs/e2e-testing.md, "Probes and CI"). So each member they reach is looked for here on a
// real `Terminals`, and a rename or a move fails in a second. A caller that stops going
// through a member a probe wraps still passes.

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The files that cast the deck's `Terminals` (`run.deck.terminals`, a `terminals` taken from
 * it, or the deck), each checked below.
 */
const reaching = [
  "doorbell.e2e.ts",
  "person.e2e.ts",
  "probes/agy-stop-boundary.e2e.ts",
  "probes/interrupt-held-reply.e2e.ts",
]

type Process = { write: unknown; onData: unknown }
type Inside = {
  readonly records: Map<string, { bound: unknown; terminal: { pty: Process } }>
  readonly bindings: { applyFact: unknown }
  readonly reporting: { report: unknown }
  readonly messaging: { delivery(id: string): unknown; ring: unknown; ringFailed: unknown }
  live(id: string): { terminal: { screen: Parameters<typeof readScreen>[0]; pty: Process } }
}

/** A runner's `Terminals` with one terminal running, as an e2e run's deck holds them. */
const running = async (resources: Resources) => {
  const terminals = new Terminals(ptyOptions)
  resources.defer(() => terminals.shutdown())
  const { id } = await terminals.create(
    { id: randomUUID(), sessionId: "session", cwd: process.cwd(), cols: 80, rows: 24 },
    "creator",
  )
  return { inside: terminals as unknown as Inside, id }
}

describe("the e2e reach-ins", () => {
  it("are all checked here", () => {
    const files = readdirSync(here, { recursive: true, encoding: "utf8" }).filter(
      (file) =>
        file.endsWith(".ts") &&
        file !== "reach-ins.test.ts" &&
        /\b(?:terminals|deck)\)?\s+as\s+(?:unknown|never|any)\b/.test(
          readFileSync(join(here, file), "utf8"),
        ),
    )
    expect(files.map((file) => file.replaceAll("\\", "/")).toSorted()).toEqual(reaching)
  })

  it("doorbell's: messaging's ring, a live terminal's screen and pty", async ({ resources }) => {
    const { inside, id } = await running(resources)
    expect(inside.messaging.ring).toBeTypeOf("function")
    expect(inside.messaging.ringFailed).toBeTypeOf("function")
    const { terminal } = inside.live(id)
    expect(terminal.screen.write).toBeTypeOf("function")
    expect(terminal.pty.write).toBeTypeOf("function")
  })

  it("person's: a live terminal's screen, as the reader reads it", async ({ resources }) => {
    const { inside, id } = await running(resources)
    expect(readScreen(inside.live(id).terminal.screen).rows).toHaveLength(24)
  })

  it("agy-stop-boundary's: records, reporting's report, messaging's delivery", async ({
    resources,
  }) => {
    const { inside, id } = await running(resources)
    const record = inside.records.get(id)!
    expect(record).toHaveProperty("bound", null)
    expect(record.terminal.pty.write).toBeTypeOf("function")
    expect(record.terminal.pty.onData).toBeTypeOf("function")
    // The probe wraps `report` on the instance and deletes its wrapper after, which leaves the
    // class's own only while that is where it lives.
    expect(inside.reporting.report).toBeTypeOf("function")
    expect(Object.hasOwn(inside.reporting, "report")).toBe(false)
    expect(inside.messaging.delivery(id)).toHaveProperty("box")
  })

  it("interrupt-held-reply's: the bindings' applyFact", async ({ resources }) => {
    const { inside } = await running(resources)
    expect(inside.bindings.applyFact).toBeTypeOf("function")
  })
})
