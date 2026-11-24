import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HarnessEvent } from "@novadeck/harness-core/events"
import { afterAll, describe, expect, it } from "vitest"

import { followTranscript, stoppedEvent } from "./transcript-watch.js"

const run = { sessionId: "s1", instance: "7" }

// The lines Novadeck's extension writes as runs settle (extension-source.ts; its writes probed
// 2026-11-24 on pi 1.6.0: a run that finished, then one stopped with Escape).
const finished = '{"type":"stopped","session_id":"s1","at":1795520620960,"error":null}'
const aborted = '{"type":"stopped","session_id":"s1","at":1795520624574,"error":"aborted"}'

describe("a run's end, as Novadeck's extension marks it", () => {
  it("ends the turn as recorded, completed, interrupted or failed", () => {
    expect(stoppedEvent(finished, run)).toEqual({
      type: "turn-ended",
      agent: "pi",
      sessionId: "s1",
      instance: "7",
      startedAt: 1795520620960,
      outcome: "completed",
      recorded: true,
    })
    expect(stoppedEvent(aborted, run)).toMatchObject({ outcome: "interrupted" })
    expect(stoppedEvent(finished.replace('"error":null', '"error":"error"'), run)).toMatchObject({
      outcome: "failed",
    })
  })

  it("reads nothing from another session's mark or any other line", () => {
    expect(stoppedEvent(finished.replace('"s1"', '"s2"'), run)).toBeUndefined()
    expect(stoppedEvent('{"type":"message"}', run)).toBeUndefined()
    expect(stoppedEvent("not json", run)).toBeUndefined()
  })
})

describe("following the extension's marks", () => {
  let plugin: string

  afterAll(() => rm(plugin, { recursive: true, force: true }))

  it("ends a turn as the session's mark is written in the plugin's folder", async () => {
    plugin = await mkdtemp(join(tmpdir(), "pi-watch-"))
    const signal = new AbortController()
    const told: HarnessEvent[] = []
    const following = followTranscript(
      {
        ...run,
        transcript: "/home/person/.pi/agent/sessions/p/x_s1.jsonl",
        plugin: () => Promise.resolve(plugin),
      },
      signal.signal,
      (event) => told.push(event),
    )
    await mkdir(join(plugin, "stopped"), { recursive: true })
    await appendFile(join(plugin, "stopped", "s1.jsonl"), `${finished}\n`)
    await expect.poll(() => told.length, { timeout: 5000 }).toBe(1)
    signal.abort()
    await following
    expect(told[0]).toMatchObject({ type: "turn-ended", outcome: "completed", recorded: true })
  })

  it("follows nothing without the plugin's folder", async () => {
    const told: HarnessEvent[] = []
    await followTranscript({ ...run, transcript: "/x" }, new AbortController().signal, (event) =>
      told.push(event),
    )
    expect(told).toEqual([])
  })
})
