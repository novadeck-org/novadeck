import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HarnessEvent } from "@novadeck/harness-core/events"
import { afterEach, describe, expect, it } from "vitest"

import { followRollout } from "./rollout.js"

const session = { sessionId: "s", instance: "7" }

// A turn's end as a rollout records it.
const ended = (turn: string, at: string) =>
  JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turn, last_agent_message: null },
  })

const turns = (told: readonly HarnessEvent[]) =>
  told.flatMap((event) => (event.type === "turn-ended" && event.turn ? [event.turn] : []))

describe("following a rollout", () => {
  let folder: string | undefined
  afterEach(() => {
    if (folder) rmSync(folder, { recursive: true, force: true })
    folder = undefined
  })

  it("tells only the latest of what it held again, never each old record, once the file is rewritten", async () => {
    folder = mkdtempSync(join(tmpdir(), "novadeck-rollout-"))
    const path = join(folder, "rollout.jsonl")
    writeFileSync(path, `${ended("t1", "2026-11-01T10:00:00Z")}\n${ended("t2", "2026-11-01T10:01:00Z")}\n`)
    const told: HarnessEvent[] = []
    const controller = new AbortController()
    const following = followRollout({ ...session, transcript: path }, controller.signal, (event) =>
      told.push(event),
    )
    try {
      await expect.poll(() => turns(told), { timeout: 5000 }).toEqual(["t2"])
      // Another file put in its place, as a migration or a sync tool writes one, holding
      // the same turns and one more.
      const next = join(folder, "next.jsonl")
      writeFileSync(
        next,
        [
          ended("t1", "2026-11-01T10:00:00Z"),
          ended("t2", "2026-11-01T10:01:00Z"),
          ended("t3", "2026-11-01T10:02:00Z"),
          "",
        ].join("\n"),
      )
      renameSync(next, path)
      await expect.poll(() => turns(told), { timeout: 5000 }).toEqual(["t2", "t3"])
    } finally {
      controller.abort()
      await following
    }
  })
})
