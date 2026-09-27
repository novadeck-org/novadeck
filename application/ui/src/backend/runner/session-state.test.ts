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

    it("keeps names, order, counter, layouts, view, selection and visit time", () => {
      const { state } = session()
      expect(saved).toMatchObject({
        visitedAt: 1_234,
        rank: 2,
        state: {
          roster: {
            terminals: [
              { id: "01", name: "Terminal 01", directory: "~/one" },
              { id: "02", name: "Terminal 02", directory: "~/one" },
            ],
            order: ["02", "01"],
            nextNumber: state.roster.nextNumber,
          },
          view: "canvas",
          windowedView: "canvas",
          selected: "02",
        },
      })
      expect(saved?.state.layout.canvas.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 })
      expect(saved?.state.layout.canvas.minimized).toEqual({ "02": true })
    })

    it("leaves out what the runner reports and gestures in progress", () => {
      expect(saved?.state.roster.terminals[1]).toEqual({
        id: "02",
        name: "Terminal 02",
        directory: "~/one",
      })
      expect(saved?.state.layout.canvas.geometry["01"]).toEqual({
        position: { x: 10, y: 20 },
        width: 400,
        height: 300,
      })
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
          text.replace('"name":"Terminal 01"', '"name":1'),
        ].map(decodeSession),
      ).toEqual(Array.from({ length: 9 }, () => undefined))
    })
  })
})
