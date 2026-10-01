import { createTerminalState } from "../../model/state"
import type { WorkspaceSession } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { terminalFixture } from "../../test/fixtures"
import { decodeSession, encodeSession } from "./session-state"

const session = (): WorkspaceSession => {
  const state = createTerminalState(
    [terminalFixture(1, "~/one"), { ...terminalFixture(2, "~/one"), state: "running" }],
    "canvas",
    "canvas",
    {
      canvasLayout: {
        minimized: { "02": true },
        viewport: { x: 1, y: 2, zoom: 0.5 },
        geometry: {
          "01": { position: { x: 10, y: 20 }, width: 400, height: 300, dragging: true },
        },
      },
    },
  )
  return {
    id: "session",
    name: "Session",
    visitedAt: 1_234,
    state: { ...state, roster: { ...state.roster, order: ["02", "01"] }, selected: "02" },
  }
}

describe("saved session state", () => {
  context("after a round trip", () => {
    const saved = decodeSession(encodeSession(session(), 2))

    it("keeps order, layouts, view, selection and visit time", () => {
      expect(saved).toMatchObject({
        visitedAt: 1_234,
        rank: 2,
        state: { order: ["02", "01"], view: "canvas", windowedView: "canvas", selected: "02" },
      })
      expect(saved?.state.layout.canvas.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 })
      expect(saved?.state.layout.canvas.minimized).toEqual({ "02": true })
    })

    it("leaves out the terminals, which the runner keeps, and gestures in progress", () => {
      const text = encodeSession(session(), 2)
      expect(text).not.toContain("Terminal 01")
      expect(text).not.toContain("~/one")
      expect(JSON.parse(text).state).not.toHaveProperty("roster")
      expect(saved?.state.layout.canvas.geometry["01"]).toEqual({
        position: { x: 10, y: 20 },
        width: 400,
        height: 300,
      })
    })
  })

  context("when it was saved by a build that kept the terminals too", () => {
    it("reads nothing, as that build is gone", () => {
      const current = JSON.parse(encodeSession(session(), 1)) as {
        state: Record<string, unknown>
      }
      const { order, ...rest } = current.state
      const old = JSON.stringify({ ...current, state: { ...rest, roster: { order } } })
      expect(decodeSession(old)).toBeUndefined()
    })
  })

  context("when the runner has nothing this build can read", () => {
    it("reads nothing", () => {
      const text = encodeSession(session(), 0)
      const broken = JSON.parse(text) as Record<string, unknown>
      expect(
        [
          null,
          "",
          "not json",
          "[]",
          JSON.stringify({ ...broken, version: 99 }),
          JSON.stringify({ ...broken, rank: 3 }),
          JSON.stringify({ ...broken, state: { ...(broken.state as object), view: "list" } }),
          JSON.stringify({ ...broken, state: { ...(broken.state as object), layout: {} } }),
          JSON.stringify({ ...broken, state: { ...(broken.state as object), order: [1] } }),
        ].map(decodeSession),
      ).toEqual(Array.from({ length: 9 }, () => undefined))
    })
  })
})
