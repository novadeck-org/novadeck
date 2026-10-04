import { messagesKey } from "../../model/companion-bar"
import { workspaceReducer, type WorkspaceAction } from "../../model/state"
import type { Workspace } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import { itemFixture, workspaceFixture } from "../../test/fixtures"

const target = { projectId: "project", workspaceSessionId: "initial" }
// Terminal 01's agent has a plan and has shown an image.
const plan = itemFixture("plan", "01", {
  kind: "plan",
  name: "A home for Studio",
  plan: { agent: "Codex", role: "root", source: "file" },
})
const hero = itemFixture("hero", "01", { kind: "image", name: "hero.png", path: "/p/hero.png" })

const withItems = (workspace: Workspace = workspaceFixture()): Workspace =>
  [plan, hero]
    .map((item): WorkspaceAction => ({ type: "item/upsert", target, item }))
    .reduce(workspaceReducer, workspace)

const open = (options: Parameters<typeof openCommands>[0] = {}) => {
  const app = openCommands({ workspace: withItems(), ...options })
  const item = (id: string) => app.state().items.find((each) => each.id === id)
  const windows = () => app.state().roster.windows
  const bar = (terminalId: string) => app.state().bars[terminalId]
  return { ...app, item, windows, bar }
}

describe("companion commands", () => {
  context("when undocking an item", () => {
    it("opens it in a window of its own beside its terminal, named for it, selected", () => {
      const app = open()
      app.commands.undock(hero.id)
      expect(app.windows()).toEqual([
        { id: "session-1", itemId: hero.id, name: "hero.png", titleSource: { kind: "default" } },
      ])
      expect(app.item(hero.id)!.holder).toEqual({ windowId: "session-1" })
      expect(app.bar("01")!.order).toEqual([plan.id])
      expect(app.state().selected).toBe("session-1")
      expect(app.urls.at(-1)).toContain("terminal=session-1")
    })

    it("brings the window already open forward rather than opening another", () => {
      const app = open()
      app.commands.undock(hero.id)
      app.commands.setSelected("02")
      app.commands.undock(hero.id)
      expect(app.windows()).toHaveLength(1)
      expect(app.urls.at(-1)).toContain("terminal=session-1")
    })

    it("opens nothing for what the session doesn't have", () => {
      const app = open()
      const before = app.state()
      app.commands.undock("gone" as typeof hero.id)
      expect(app.state()).toBe(before)
    })
  })

  context("when an item is dropped into a view", () => {
    it("opens its window where it was dropped on the canvas, settled onto the grid", () => {
      const app = open()
      app.commands.undock(hero.id, { canvas: { x: 83, y: 970 } })
      expect(app.state().layout.canvas.geometry["session-1"]).toMatchObject({
        position: { x: 72, y: 960 },
      })
    })

    it("moves a window already open there, keeping its size", () => {
      const app = open()
      app.commands.undock(hero.id)
      const { width, height } = app.state().layout.canvas.geometry["session-1"]!
      app.commands.undock(hero.id, { canvas: { x: 408, y: 240 } })
      expect(app.state().layout.canvas.geometry["session-1"]).toMatchObject({
        position: { x: 408, y: 240 },
        width,
        height,
      })
    })

    it("opens its window in the cell it was dropped in on the grid, in the layout it made", () => {
      const app = open()
      const cell = { x: 6, y: 24, w: 6, h: 18 }
      const moved = { i: "02", x: 0, y: 48, w: 4, h: 18 }
      app.commands.undock(hero.id, { grid: { breakpoint: "desktop", layout: [moved], cell } })
      expect(app.state().layout.grid.desktop).toEqual([
        moved,
        expect.objectContaining({ i: "session-1", ...cell }),
      ])
    })
  })

  context("when docking a window back in", () => {
    it("puts its item back on its terminal's bar, open there, and selects the terminal", () => {
      const app = open()
      app.commands.undock(plan.id)
      app.commands.dock("session-1")
      expect(app.windows()).toEqual([])
      expect(app.item(plan.id)!.holder).toEqual({ terminalId: "01" })
      expect(app.bar("01")).toMatchObject({ order: [hero.id, plan.id], tab: plan.id, open: true })
      expect(app.state().selected).toBe("01")
    })

    it("does nothing once its terminal has closed", () => {
      const app = open()
      app.commands.undock(hero.id)
      app.workspace.dispatch({ type: "terminal/close", target, terminalId: "01" })
      const before = app.state()
      app.commands.dock("session-1")
      expect(app.state()).toBe(before)
    })
  })

  context("when items are placed on another terminal's bar", () => {
    it("moves them there, each last", () => {
      const app = open()
      app.commands.place([hero.id, plan.id], "02")
      expect(app.bar("02")!.order).toEqual([hero.id, plan.id])
      expect(app.bar("01")!.order).toEqual([])
    })

    it("places nothing on a window", () => {
      const app = open()
      app.commands.undock(plan.id)
      const before = app.state()
      app.commands.place([hero.id], "session-1")
      expect(app.state()).toBe(before)
    })
  })

  context("when an item is closed", () => {
    it("hides a plan on its own terminal's bar, keeping it", () => {
      const app = open()
      app.commands.closeItem(plan.id)
      expect(app.bar("01")).toMatchObject({ order: [hero.id], hidden: [plan.id] })
      expect(app.item(plan.id)).toBeDefined()
    })

    it("deletes anything else, a plan placed elsewhere too", () => {
      const app = open()
      app.commands.place([plan.id], "02")
      app.commands.closeItem(plan.id)
      app.commands.closeItem(hero.id)
      expect(app.state().items).toEqual([])
    })

    it("deletes what a window shows, and the window, when the window is closed", () => {
      const app = open()
      app.commands.undock(hero.id)
      app.commands.close("session-1")
      expect(app.windows()).toEqual([])
      expect(app.item(hero.id)).toBeUndefined()
      expect(app.ui.getSnapshot().closing).toBeNull()
    })
  })

  context("when the person arranges a bar", () => {
    it("opens its pane to what they pick, and hides it again", () => {
      const app = open()
      app.commands.openBarTab("01", hero.id)
      expect(app.bar("01")).toMatchObject({ tab: hero.id, open: true })
      expect(app.state().fresh).not.toHaveProperty(hero.id)
      app.commands.closeBarPane("01")
      expect(app.bar("01")).toMatchObject({ open: false })
    })

    it("takes what they peeked at as seen, leaving the pane as it was", () => {
      const app = open()
      expect(app.state().fresh).toHaveProperty(hero.id)
      app.commands.markSeen([hero.id])
      expect(app.state().fresh).not.toHaveProperty(hero.id)
      expect(app.state().fresh).toHaveProperty(plan.id)
      expect(app.bar("01")).toMatchObject({ open: false })
    })

    it("hides the messages and moves icons", () => {
      const app = open()
      app.commands.hideOnBar("01", messagesKey)
      expect(app.bar("01")!.hidden).toEqual([messagesKey])
      app.commands.moveBarSlot("01", [[plan.id], [hero.id]], 1, 0)
      expect(app.bar("01")!.order).toEqual([hero.id, plan.id])
    })
  })
})
