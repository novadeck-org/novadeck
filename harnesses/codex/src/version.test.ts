import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HarnessEvent } from "@novadeck/harness-core/events"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { afterEach, describe, expect, it } from "vitest"

import { followRollout, rolloutEvents } from "./rollout.js"

const probe = loadProbe(import.meta.dirname, "version.probe.json") as {
  version: string
  rollout: string[]
}
const meta = JSON.parse(probe.rollout[0]!) as { payload: Record<string, unknown> }
const session = { sessionId: meta.payload.id as string, instance: "7" }

describe("the version of Codex that wrote a rollout, as captured", () => {
  it("is the cli_version of its first record, told for the session followed as the release that created it", () => {
    expect(rolloutEvents(probe.rollout[0]!, session)).toEqual([
      {
        type: "telemetry-observed",
        agent: "codex",
        sessionId: session.sessionId,
        instance: "7",
        startedAt: expect.any(Number),
        version: probe.version,
        created: true,
      },
    ])
  })

  it("is not taken from a record that names none, or a value that is no version", () => {
    const without = { ...meta, payload: { ...meta.payload, cli_version: undefined } }
    expect(rolloutEvents(JSON.stringify(without), session)).toEqual([])
    const odd = { ...meta, payload: { ...meta.payload, cli_version: "nightly" } }
    expect(rolloutEvents(JSON.stringify(odd), session)).toEqual([])
  })

  it("is not taken from the record of another thread, as a fork's or subagent's parent", () => {
    expect(rolloutEvents(probe.rollout[0]!, { ...session, sessionId: "another" })).toEqual([])
  })
})

describe("following the version a rollout says", () => {
  let folder: string | undefined
  afterEach(() => {
    if (folder) rmSync(folder, { recursive: true, force: true })
    folder = undefined
  })

  // A token count, as Codex writes it after a turn.
  const count = JSON.stringify({
    timestamp: "2026-11-03T16:33:16.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { total_tokens: 1109 }, model_context_window: 190000 },
      rate_limits: null,
    },
  })

  it.each([
    ["before", "a token count"],
    ["after", "a token count"],
  ])("tells it with the usage, the session_meta %s %s", async (order) => {
    folder = mkdtempSync(join(tmpdir(), "version-"))
    const path = join(folder, "rollout.jsonl")
    const lines = order === "before" ? [probe.rollout[0]!, count] : [count, probe.rollout[0]!]
    writeFileSync(path, lines.map((line) => `${line}\n`).join(""))
    const controller = new AbortController()
    const told: HarnessEvent[] = []
    const following = followRollout({ ...session, transcript: path }, controller.signal, (event) =>
      told.push(event),
    )
    try {
      for (let waited = 0; told.length < 2 && waited < 5000; waited += 50)
        // eslint-disable-next-line no-await-in-loop -- Polls the file's follower.
        await new Promise((resolve) => setTimeout(resolve, 50))
      expect(told).toHaveLength(2)
      expect(told).toContainEqual(expect.objectContaining({ version: probe.version }))
      expect(told).toContainEqual(
        expect.objectContaining({ context: { occupied: 1109, capacity: 190000 } }),
      )
    } finally {
      controller.abort()
      await following
    }
  })
})
