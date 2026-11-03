import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { rolloutEvents } from "./rollout.js"

const probe = loadProbe(import.meta.dirname, "version.probe.json") as {
  version: string
  rollout: string[]
}
const session = { sessionId: "s", instance: "7" }

describe("the version of Codex that wrote a rollout, as captured", () => {
  it("is the cli_version of its first record, told for the session followed", () => {
    expect(rolloutEvents(probe.rollout[0]!, session)).toEqual([
      {
        type: "telemetry-observed",
        agent: "codex",
        sessionId: "s",
        instance: "7",
        startedAt: expect.any(Number),
        version: probe.version,
      },
    ])
  })

  it("is not taken from a record that names none, or a value that is no version", () => {
    const meta = JSON.parse(probe.rollout[0]!) as { payload: Record<string, unknown> }
    const without = { ...meta, payload: { ...meta.payload, cli_version: undefined } }
    expect(rolloutEvents(JSON.stringify(without), session)).toEqual([])
    const odd = { ...meta, payload: { ...meta.payload, cli_version: "nightly" } }
    expect(rolloutEvents(JSON.stringify(odd), session)).toEqual([])
  })
})
