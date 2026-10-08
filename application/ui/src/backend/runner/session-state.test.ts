import { messagesKey } from "../../model/companion-bar"
import { createTerminalState } from "../../model/state"
import type { WorkspaceSession } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { itemFixture, terminalFixture } from "../../test/fixtures"
import { decodeSession, encodeSession } from "./session-state"

const session = (): WorkspaceSession => {
  const state = createTerminalState(
    [terminalFixture(1, "~/one"), { ...terminalFixture(2, "~/one"), state: "running" }],
    "canvas",
    "canvas",
    {
      canvasLayout: {
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

  context("with companion bars", () => {
    // Terminal 01 holds `count` items on its bar, and 02 holds one; 01's bar also
    // remembers an item that's gone and hides its messages.
    const withBars = (count: number): WorkspaceSession => {
      const base = session()
      const many = Array.from({ length: count }, (_, index) =>
        itemFixture(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, "01"),
      )
      const other = itemFixture("other", "02")
      return {
        ...base,
        state: {
          ...base.state,
          items: [...many, other],
          bars: {
            "01": {
              order: [...many.map((item) => item.id), "gone" as (typeof many)[number]["id"]],
              hidden: [messagesKey],
              tab: many[0]?.id ?? null,
              open: true,
            },
            "02": { order: [other.id], hidden: [], tab: null, open: false },
            "99": { order: [other.id], hidden: [], tab: null, open: false },
          },
        },
      }
    }

    it("keeps each terminal's bar, less what's gone", () => {
      const saved = decodeSession(encodeSession(withBars(2), 1))
      const ids = withBars(2).state.items.map((item) => item.id)
      expect(saved?.state.bars).toEqual({
        "01": { order: [ids[0], ids[1]], hidden: [messagesKey], tab: ids[0], open: true },
        "02": { order: ["other"], hidden: [], tab: null, open: false },
      })
    })

    it("drops the order and hidden entries of the largest bars first when it would not fit", () => {
      const big = withBars(40)
      const whole = encodeSession(big, 1, Infinity)
      const text = encodeSession(big, 1, whole.length - 1)
      expect(text.length).toBeLessThan(whole.length)
      const saved = decodeSession(text)
      expect(saved?.state.bars?.["01"]).toMatchObject({ order: [], hidden: [], open: true })
      expect(saved?.state.bars?.["02"]?.order).toEqual(["other"])
    })

    it("reads a bar it can't make sense of as none", () => {
      const text = JSON.parse(encodeSession(withBars(1), 1)) as {
        state: { bars: Record<string, unknown> }
      }
      text.state.bars["01"] = { order: "nope" }
      expect(decodeSession(JSON.stringify(text))?.state.bars).toEqual({
        "02": { order: ["other"], hidden: [], tab: null, open: false },
      })
    })
  })
})
