import { RunnerError } from "@novadeck/protocol/client"
import { afterEach, beforeEach, vi } from "vitest"

import type { Workspace } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { workspaceFixture } from "../../test/fixtures"
import { createSessionSaves } from "./saves"

const renamed = (workspace: Workspace, name: string): Workspace => ({
  ...workspace,
  projects: workspace.projects.map((project) => ({
    ...project,
    history: project.history.map((session) => ({ ...session, name })),
  })),
})

// Saves over a runner that records each call and answers as `answer` says.
const open = (answer: () => Promise<void> = async () => {}) => {
  const sent: string[] = []
  let latest: Workspace | undefined
  const saves = createSessionSaves({
    save: (sessionId) => {
      sent.push(sessionId)
      return answer()
    },
    ready: () => Promise.resolve(true),
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
  return { saves, sent, commit }
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

    it("tries again shortly while the runner is busy", async () => {
      let busy = true
      const app = open(async () => {
        if (busy) throw new RunnerError("RESOURCE_LIMIT", "Busy.")
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
})
