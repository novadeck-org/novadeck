import { readFileSync } from "node:fs"

import { context, describe, expect, it } from "../../test"
import type { Run } from "./scoreboard"
import { dailyCron, renderStarts, scheduledBefore } from "./starts"

const night = (id: number, at: string): Run => ({
  id,
  name: "Nightly Quality",
  event: "schedule",
  conclusion: "success",
  created_at: at,
  run_attempt: 1,
  actor: { login: "someone" },
})

const pinned = (id: number, at: string): Run => ({
  ...night(id, at),
  name: "E2E",
  event: "workflow_dispatch",
  actor: { login: "github-actions[bot]" },
})

const cron = { minute: 23, hour: 17 }

describe("each night's start", () => {
  it("reads Nightly Quality's daily cron from its workflow, and no other kind", () => {
    expect(dailyCron(readFileSync(".github/workflows/quality-nightly.yml", "utf8"))).toEqual(cron)
    expect(dailyCron('    - cron: "7 4 * * 0"')).toBeUndefined()
  })

  context("when GitHub starts a night late", () => {
    it("finds the cron's time it was late for, the evening before when it starts after midnight", () => {
      expect(
        new Date(scheduledBefore(cron, Date.parse("2026-11-13T00:58:00Z"))).toISOString(),
      ).toBe("2026-11-12T17:23:00.000Z")
    })

    it("finds the same evening's when it starts on time", () => {
      expect(
        new Date(scheduledBefore(cron, Date.parse("2026-11-12T17:40:00Z"))).toISOString(),
      ).toBe("2026-11-12T17:23:00.000Z")
    })
  })

  it("shows each night's scheduled start, its real one and how late, and its pinned E2E's", () => {
    const line = renderStarts(
      [
        night(1, "2026-11-12T17:40:00Z"),
        pinned(2, "2026-11-12T18:32:00Z"),
        night(3, "2026-11-14T00:58:00Z"),
        pinned(4, "2026-11-14T01:52:00Z"),
        night(5, "2026-11-14T23:59:00Z"),
      ],
      cron,
    )
    expect(line).toContain(
      "scheduled → Nightly Quality started → its pinned E2E started: 11-12 17:23 → 11-12 17:40 (+0h17m) → 11-12 18:32; 11-13 17:23 → 11-14 00:58 (+7h35m) → 11-14 01:52; 11-14 17:23 → 11-14 23:59 (+6h36m) → none.",
    )
  })

  it("says nothing without a night, and shows no schedule it can't read", () => {
    expect(renderStarts([], cron)).toBe("")
    expect(renderStarts([night(1, "2026-11-13T00:58:00Z")], undefined)).toContain(
      ": ? → 11-13 00:58 → none.",
    )
  })
})
