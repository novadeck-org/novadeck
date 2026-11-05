import { workspaceFixture } from "@novadeck/core/testing"
import type { Workspace } from "@novadeck/core/types"
import { WireError } from "@novadeck/wire"
import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { catchReports } from "../testing/reported"
import { createSessionSaves } from "./saves"

const visited = (workspace: Workspace, visitedAt: number | null): Workspace => ({
  ...workspace,
  projects: workspace.projects.map((project) => ({
    ...project,
    history: project.history.map((session) => ({ ...session, visitedAt })),
  })),
})

const renamed = (workspace: Workspace, name: string): Workspace => ({
  ...workspace,
  projects: workspace.projects.map((project) => ({
    ...project,
    history: project.history.map((session) => ({ ...session, name })),
  })),
})

// Saves over a runner that records each call and answers as `answer` says, and whose sessions
// exist as `ready` says.
const open = (answer: () => Promise<void> = async () => {}, ready = async () => true) => {
  const sent: string[] = []
  const visits: (number | null)[] = []
  let latest: Workspace | undefined
  const saves = createSessionSaves({
    save: (sessionId, _state, visitedAt) => {
      sent.push(sessionId)
      visits.push(visitedAt)
      return answer()
    },
    ready: () => ready(),
    latest: () => latest,
    track: (work) => work,
    halted: () => false,
    delay: 800,
    saved: [],
  })
  const commit = (workspace: Workspace): void => {
    latest = workspace
    saves.note(workspace)
  }
  return { saves, sent, visits, commit }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("session saves", () => {
  context("when the workspace first arrives", () => {
    it("sends nothing, as the runner already has it", async () => {
      const app = open()
      app.commit(workspaceFixture())
      await vi.advanceTimersByTimeAsync(5_000)
      expect(app.sent).toEqual([])
    })
  })

  context("when a session changes", () => {
    it("sends it once after a quiet spell, and not again while unchanged", async () => {
      const app = open()
      const first = workspaceFixture()
      app.commit(first)
      const changed = renamed(first, "Renamed")
      app.commit(changed)
      await vi.advanceTimersByTimeAsync(700)
      expect(app.sent).toEqual([])
      await vi.advanceTimersByTimeAsync(100)
      expect(app.sent).toEqual(["initial"])
      app.commit(renamed(changed, "Renamed"))
      app.saves.flush()
      await vi.advanceTimersByTimeAsync(0)
      expect(app.sent).toEqual(["initial"])
    })

    it("sends a visit alone, which leaves the state as it was", async () => {
      const app = open()
      const first = visited(workspaceFixture(), null)
      app.commit(first)
      app.commit(visited(first, 9))
      app.saves.flush()
      await vi.advanceTimersByTimeAsync(0)
      expect(app.sent).toEqual(["initial"])
      expect(app.visits).toEqual([9])
    })

    it("sends a session never visited with no visit, not a stamp of its own", async () => {
      const app = open()
      const first = visited(workspaceFixture(), null)
      app.commit(first)
      app.commit(renamed(first, "Renamed"))
      app.saves.flush()
      await vi.advanceTimersByTimeAsync(0)
      expect(app.visits).toEqual([null])
    })

    it("tries again shortly while the runner is busy", async () => {
      let busy = true
      const app = open(async () => {
        if (busy) throw new WireError("RESOURCE_LIMIT", "Busy.")
      })
      const first = workspaceFixture()
      app.commit(first)
      app.commit(renamed(first, "Renamed"))
      await vi.advanceTimersByTimeAsync(800)
      busy = false
      await vi.advanceTimersByTimeAsync(500)
      expect(app.sent).toEqual(["initial", "initial"])
      expect(app.saves.busy()).toBe(false)
    })
  })

  context("when the runner refuses a save for another reason", () => {
    it("reports it, and sends the session again only with its next change", async () => {
      const { reported, restore } = catchReports()
      const refusal = new WireError("INTERNAL_ERROR", "The runner broke.")
      const app = open(async () => {
        throw refusal
      })
      const first = workspaceFixture()
      try {
        app.commit(first)
        app.commit(renamed(first, "Renamed"))
        await vi.advanceTimersByTimeAsync(5_000)
      } finally {
        restore()
      }
      expect(app.sent).toEqual(["initial"])
      expect(reported).toEqual([refusal])
    })
  })

  context("when the session isn't on the runner yet", () => {
    it("keeps its change for the next send, which asks for the session again", async () => {
      let there = false
      const app = open(undefined, async () => there)
      const first = workspaceFixture()
      app.commit(first)
      app.commit(renamed(first, "Renamed"))
      await vi.advanceTimersByTimeAsync(800)
      expect(app.sent).toEqual([])
      there = true
      app.saves.flush()
      await vi.advanceTimersByTimeAsync(0)
      expect(app.sent).toEqual(["initial"])
    })
  })

  context("before a window closes or the app quits", () => {
    it("sends what changed at once and settles once the runner answered", async () => {
      let accept!: () => void
      const app = open(() => new Promise((resolve) => (accept = resolve)))
      const first = workspaceFixture()
      app.commit(first)
      app.commit(renamed(first, "Renamed"))
      let settled = false
      const settling = app.saves.settle().then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(app.sent).toEqual(["initial"])
      expect(settled).toBe(false)
      accept()
      await settling
    })

    it("takes the runner refusing saves while it shuts down as the end of saving", async () => {
      const app = open(async () => {
        throw new WireError("CLOSING", "Closing.")
      })
      const first = workspaceFixture()
      app.commit(first)
      app.commit(renamed(first, "Renamed"))
      await expect(app.saves.settle()).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(app.sent).toEqual(["initial"])
      expect(app.saves.busy()).toBe(false)
    })
  })
})
