import { context, describe, expect, it } from "../test"
import { terminalFixture, workspaceFixture } from "../test/fixtures"
import { forgetTerminal, place, unplace, type Placement } from "./companion-items"
import { activeSession, workspaceReducer, type WorkspaceAction } from "./state"
import type { Workspace } from "./types"

const hero = { kind: "artifact", id: "hero" } as const
const plan = { kind: "plan", ref: "root" } as const
const target = { projectId: "project", workspaceSessionId: "initial" }

const apply = (workspace: Workspace, ...actions: WorkspaceAction[]): Workspace =>
  actions.reduce(workspaceReducer, workspace)
const placements = (workspace: Workspace): readonly Placement[] =>
  activeSession(workspace)!.state.placements
const placing = (from: string, item: Placement["item"], to: string): WorkspaceAction => ({
  type: "companion/place",
  target,
  placements: [{ from, item, to }],
})

describe("placements", () => {
  it("put an item on one taskbar at a time, the latest last", () => {
    const once = place([], { from: "01", item: hero, to: "02" })
    const moved = place(place(once, { from: "01", item: plan, to: "02" }), {
      from: "01",
      item: hero,
      to: "03",
    })
    expect(moved).toEqual([
      { from: "01", item: plan, to: "02" },
      { from: "01", item: hero, to: "03" },
    ])
  })

  it("send an item placed on its own terminal home", () => {
    expect(
      place([{ from: "01", item: hero, to: "02" }], { from: "01", item: hero, to: "01" }),
    ).toEqual([])
  })

  it("leave the list as it was when there's nothing to forget", () => {
    const list = [{ from: "01", item: hero, to: "02" }]
    expect(unplace(list, "01", plan)).toBe(list)
    expect(forgetTerminal(list, "03")).toBe(list)
  })

  context("in a session", () => {
    const three = workspaceFixture({ terminals: 3 })

    it("go home when either terminal closes", () => {
      const placed = apply(three, placing("01", hero, "02"), placing("03", plan, "01"))
      const closed = apply(placed, { type: "terminal/close", target, terminalId: "01" })
      expect(placements(closed)).toEqual([])
    })

    it("go home when the item is undocked", () => {
      const window = {
        ...terminalFixture(4, "~/project"),
        companion: { from: "01", item: hero },
      }
      const undocked = apply(three, placing("01", hero, "02"), {
        type: "terminal/add",
        target,
        terminal: window,
      })
      expect(placements(undocked)).toEqual([])
    })

    it("take no terminal the session doesn't have, and no undocked window", () => {
      const window = { ...terminalFixture(4, "~/project"), companion: { from: "01", item: plan } }
      const withWindow = apply(three, { type: "terminal/add", target, terminal: window })
      expect(
        placements(apply(withWindow, placing("01", hero, "99"), placing("01", hero, "04"))),
      ).toEqual([])
    })
  })
})
