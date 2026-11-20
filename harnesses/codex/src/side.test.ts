import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionObserved } from "@novadeck/harness-core/events"
import { afterEach, describe, expect, it } from "vitest"

import { aside, sideRollout } from "./side.js"

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A rollout whose first line is `first`, a long one as Codex's are, and a turn after it. */
const rolloutWith = (first: string): string => {
  const folder = mkdtempSync(join(tmpdir(), "novadeck-codex-side-"))
  folders.push(folder)
  const path = join(folder, "rollout.jsonl")
  writeFileSync(path, `${first}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`)
  return path
}

// Its first records as Codex 0.171.0 wrote them (probed 2026-11-20, e2e/probes/codex-side.e2e.ts),
// with the instructions they hold cut down to a long filler.
const meta = (fields: object) =>
  JSON.stringify({
    timestamp: "2026-11-20T04:47:03.003Z",
    type: "session_meta",
    payload: {
      session_id: "01a1f747-895a-7be1-81ad-339963c38fa5",
      id: "01a1f747-895a-7be1-81ad-339963c38fa5",
      cli_version: "0.171.0",
      source: "cli",
      base_instructions: { text: "x".repeat(200_000) },
      ...fields,
    },
  })
const side = meta({
  forked_from_id: "01a1f747-81cc-7d80-8387-2e12b03e2f96",
  attached_thread: true,
  thread_source: "tui_side_chat",
})
const root = meta({ thread_source: "user" })

const observed = (transcript?: string): SessionObserved => ({
  type: "session-observed",
  agent: "codex",
  sessionId: "01a1f747-895a-7be1-81ad-339963c38fa5",
  instance: null,
  startedAt: 1,
  evidence: "native-switch",
  ...(transcript !== undefined && { transcript }),
})

describe("a /side conversation Codex keeps with its root", () => {
  it("is told by its rollout's first record, however long", async () => {
    expect(await sideRollout(rolloutWith(side))).toBe(true)
    expect(await sideRollout(rolloutWith(root))).toBe(false)
  })

  it("is unknown while its rollout holds no whole first record", async () => {
    expect(await sideRollout(rolloutWith('{"type":"session_meta","payload":{'))).toBeUndefined()
    expect(await sideRollout(join(tmpdir(), "novadeck-no-such-rollout.jsonl"))).toBeUndefined()
  })

  it("sets aside only a session whose transcript says so", async () => {
    expect(await aside(observed(rolloutWith(side)))).toBe(true)
    expect(await aside(observed(rolloutWith(root)))).toBe(false)
    // Up to 0.170.0 its hooks named no transcript, and its start never came here (decode.ts).
    expect(await aside(observed())).toBe(false)
  })
})
