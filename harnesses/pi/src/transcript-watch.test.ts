import { describe, expect, it } from "vitest"

import { stoppedEvent } from "./transcript-watch.js"

const run = { sessionId: "s1", instance: "7" }

// The entries Novadeck's extension added to a session's file as its runs settled (probed
// 2026-11-24, pi 1.6.0: a run that finished, then one stopped with Escape).
const finished =
  '{"type":"custom","customType":"novadeck-stopped","data":{"at":1795520620960,"error":null},"id":"a6f663b7","parentId":"7d6f41bd","timestamp":"2026-11-24T11:43:40.960Z"}'
const aborted =
  '{"type":"custom","customType":"novadeck-stopped","data":{"at":1795520624574,"error":"aborted"},"id":"44fef13a","parentId":"c718c299","timestamp":"2026-11-24T11:43:44.574Z"}'

describe("a run's end, as pi's session file records it", () => {
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

  it("reads nothing from any other record", () => {
    expect(stoppedEvent(finished.replace('"novadeck-stopped"', '"theirs"'), run)).toBeUndefined()
    expect(stoppedEvent('{"type":"message","message":{"role":"assistant"}}', run)).toBeUndefined()
    expect(stoppedEvent("not json", run)).toBeUndefined()
  })
})
