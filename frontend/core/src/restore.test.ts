import { sharedState, type SharedView } from "./restore"
import { createTerminalState } from "./state"
import { context, describe, expect, it } from "./test"
import { terminalFixture } from "./testing"
import type { WorkspaceState } from "./types"

const at = (x: number) => ({ position: { x, y: 0 }, width: 400, height: 300 })

// A session here with terminals 01 and 02, in Grid, 02 selected.
const here = (): WorkspaceState => ({
  ...createTerminalState([terminalFixture(1, "~/a"), terminalFixture(2, "~/b")], "grid", "grid"),
  selected: "02",
  layout: {
    canvas: { geometry: { "01": at(0), "02": at(500) } },
    hidden: {},
    spans: {},
  },
})

const view = (fields: Partial<SharedView> = {}): SharedView => ({
  order: ["02", "01"],
  layout: { canvas: { geometry: { "01": at(10), "02": at(510) } }, hidden: {}, spans: {} },
  ...fields,
})

describe("another client's shared view", () => {
  it("lays in its order and layout, and keeps where this client looks", () => {
    const state = sharedState(here(), view())
    expect(state.roster.order).toEqual(["02", "01"])
    expect(state.layout.canvas.geometry).toEqual({ "01": at(10), "02": at(510) })
    expect([state.view, state.selected]).toEqual(["grid", "02"])
  })

  context("when two clients' changes, merged, break what a session holds", () => {
    // Here 03 closed; there, its span and its hidden mark changed: merged, they name a
    // terminal that isn't here any more.
    it("drops what names a terminal that's gone, as a load does", () => {
      const merged = view({
        order: ["03", "02", "01"],
        layout: {
          canvas: { geometry: { "01": at(10), "03": at(900) } },
          hidden: { "03": true },
          spans: { "03": { columns: 2, rows: 1 } },
        },
      })
      const state = sharedState(here(), merged)
      expect(state.roster.order).toEqual(["02", "01"])
      expect(state.layout.canvas.geometry).toEqual({ "01": at(10) })
      expect([state.layout.hidden, state.layout.spans]).toEqual([{}, {}])
    })

    // There, the order was rewritten before 02 opened here: 02 follows the others in the
    // sidebar, as after a load, and keeps its place in the layout.
    it("keeps a terminal the shared order doesn't know", () => {
      const state = sharedState(here(), view({ order: ["01"] }))
      expect(state.roster.order).toEqual(["01"])
      expect(state.roster.terminals.map(({ id }) => id)).toEqual(["01", "02"])
      expect(state.layout.canvas.geometry["02"]).toEqual(at(510))
    })
  })

  it("leaves a terminal being dragged here where the person has it", () => {
    const dragging = here()
    const moving = {
      ...dragging,
      layout: {
        ...dragging.layout,
        canvas: {
          geometry: { ...dragging.layout.canvas.geometry, "01": { ...at(77), dragging: true } },
        },
      },
    }
    const state = sharedState(moving, view())
    expect(state.layout.canvas.geometry["01"]).toEqual({ ...at(77), dragging: true })
    expect(state.layout.canvas.geometry["02"]).toEqual(at(510))
  })
})
