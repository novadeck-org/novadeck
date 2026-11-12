import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HarnessEvent } from "@novadeck/harness-core/events"
import { afterEach, beforeEach, vi } from "vitest"

import { started } from "../../harnesses/activity.js"
import { Captures } from "../../harnesses/captures.js"
import { captureFolder } from "../../shell/capture.js"
import { describe, expect, it } from "../../test.js"
import type { Record } from "../record.js"
import { Bindings, type BindingsHost } from "./facts.js"

let temporary = ""
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "novadeck-facts-captures-"))
})
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true })
})

const base = { agent: "codex", sessionId: "s1", instance: "41" } as const
const record = () =>
  ({
    summary: { id: "t1" },
    closed: false,
    bound: {
      binding: { agent: "codex", sessionId: "s1", instance: "41" },
      activity: started(0),
      telemetry: null,
    },
  }) as unknown as Record

// Bindings whose source facts apply to the record alone, as the published ones would.
const bindings = () => {
  const captures = new Captures({ temporary, pollMs: 10, polls: 5 })
  const bound = new Bindings({} as unknown as BindingsHost, captures)
  const told: HarnessEvent[] = []
  vi.spyOn(bound, "sourceFact").mockImplementation((each, fact) => {
    told.push(fact)
    bound.appliedFact(each, fact)
  })
  return { bound, told }
}

describe("a Codex shell's output", () => {
  it("is the log of the capture of its command, set once the shell started", async () => {
    const folder = captureFolder("t1", temporary)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "out-1.command"), "sleep 600")
    await writeFile(join(folder, "out-1.log"), "")
    const { bound, told } = bindings()
    const each = record()
    const since = Date.now()
    bound.appliedFact(each, {
      type: "shell-started",
      ...base,
      startedAt: since,
      id: "77",
      command: "sleep 600",
    })
    await vi.waitFor(() => expect(told).toHaveLength(1))
    expect(each.bound?.activity.shells).toMatchObject([
      { id: "77", output: join(folder, "out-1.log") },
    ])
  })

  it("is left unknown, with no error, where nothing was captured", async () => {
    const { bound, told } = bindings()
    const each = record()
    bound.appliedFact(each, {
      type: "shell-started",
      ...base,
      startedAt: Date.now(),
      id: "77",
      command: "sleep 600",
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(told).toEqual([])
    expect(each.bound?.activity.shells).toMatchObject([{ id: "77" }])
  })
})
