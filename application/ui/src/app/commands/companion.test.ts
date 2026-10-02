import type { ArtifactRef, CompanionKey, Companions } from "../../model/companion"
import { mailTab, openTab, planTab, placedKey } from "../../terminals/companion/pane"
import { createPanes } from "../../terminals/companion/state"
import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import { workspaceFixture } from "../../test/fixtures"

const key = (terminalId: string): CompanionKey => ({
  projectId: "project",
  workspaceSessionId: "initial",
  terminalId,
})
const hero: ArtifactRef = { id: "hero", kind: "image", name: "hero.png", detail: "", version: 1 }
const image = { kind: "artifact", id: "hero" } as const
const plan = { kind: "plan", ref: "root" } as const

// Terminal 01's agent has a plan and has shown an image.
const companions: Companions = {
  snapshot: () => [
    {
      key: key("01"),
      plans: [
        {
          ref: "root",
          role: "root",
          path: "plan.md",
          agent: "Codex",
          skill: true,
          writable: true,
          text: "# A home for Studio\n",
          revision: "1",
        },
      ],
      shown: [hero],
    },
  ],
  subscribe: () => () => {},
  load: () => new Promise(() => {}),
  save: () => new Promise(() => {}),
}

const open = (options: Parameters<typeof openCommands>[0] = {}) => {
  const panes = createPanes(companions)
  panes.connect()
  const app = openCommands({ ...options, panes })
  const windows = () => app.state().roster.terminals.filter((each) => each.companion)
  return { ...app, panes, windows, pane: (id: string) => panes.of(key(id)).current() }
}

describe("companion commands", () => {
  context("when undocking an item", () => {
    it("adds an idle window beside the terminal, named for what it shows", () => {
      const app = open()
      app.commands.undock("01", image)
      expect(app.windows()).toEqual([
        expect.objectContaining({
          name: "hero.png",
          state: "idle",
          process: "",
          directory: "~/project",
          companion: { from: "01", item: image, artifact: hero },
        }),
      ])
      expect(app.state().selected).toBe(app.windows()[0]!.id)
    })

    it("names a plan's window by its title, one window per plan", () => {
      const app = open()
      app.commands.undock("01", plan)
      app.commands.undock("01", plan)
      expect(app.windows()).toEqual([
        expect.objectContaining({
          name: "A home for Studio",
          companion: { from: "01", item: plan },
        }),
      ])
    })

    it("brings the window already open forward rather than opening another", () => {
      const app = open()
      app.commands.undock("01", image)
      app.commands.setSelected("02")
      app.commands.undock("01", image)
      expect(app.windows()).toHaveLength(1)
      expect(app.state().selected).toBe(app.windows()[0]!.id)
    })

    it("opens nothing for what the terminal doesn't have", () => {
      const app = open()
      const before = app.state()
      app.commands.undock("01", { kind: "artifact", id: "gone" })
      app.commands.undock("99", image)
      expect(app.state()).toBe(before)
    })

    it("takes it off any other terminal's taskbar", () => {
      const app = open()
      app.commands.place([{ from: "01", item: image, to: "02" }])
      app.commands.undock("01", image)
      expect(app.state().placements).toEqual([])
    })
  })

  context("when an item is dropped into a view", () => {
    it("opens its window where it was dropped on the canvas, settled onto the grid", () => {
      const app = open()
      app.commands.undock("01", image, { canvas: { x: 83, y: 970 } })
      const id = app.windows()[0]!.id
      expect(app.state().layout.canvas.geometry[id]).toMatchObject({
        position: { x: 72, y: 960 },
      })
    })

    it("moves a window already open there, keeping its size", () => {
      const app = open()
      app.commands.undock("01", image)
      const id = app.windows()[0]!.id
      const { width, height } = app.state().layout.canvas.geometry[id]!
      app.commands.undock("01", image, { canvas: { x: 408, y: 240 } })
      expect(app.state().layout.canvas.geometry[id]).toMatchObject({
        position: { x: 408, y: 240 },
        width,
        height,
      })
    })

    it("opens its window in the cell it was dropped in on the grid, in the layout it made", () => {
      const app = open()
      const cell = { x: 6, y: 24, w: 6, h: 18 }
      const moved = { i: "02", x: 0, y: 48, w: 4, h: 18 }
      app.commands.undock("01", image, {
        grid: { breakpoint: "desktop", layout: [moved], cell },
      })
      const id = app.windows()[0]!.id
      expect(app.state().layout.grid.desktop).toEqual([
        moved,
        expect.objectContaining({ i: id, ...cell }),
      ])
    })
  })

  context("when docking a window back in", () => {
    it("closes the window and opens its item in its terminal's pane, selecting the terminal", () => {
      const app = open()
      app.commands.undock("01", plan)
      app.commands.dock(app.windows()[0]!.id)
      expect(app.windows()).toEqual([])
      expect(app.pane("01")).toMatchObject({ open: true, tab: planTab("root") })
      expect(app.state().selected).toBe("01")
    })

    it("shows what the window shows again where its terminal no longer has it", () => {
      const app = open()
      app.commands.undock("01", image)
      app.panes.of(key("01")).update((pane) => ({ ...pane, artifacts: [] }))
      app.commands.dock(app.windows()[0]!.id)
      expect(app.pane("01")).toMatchObject({ open: true, tab: "hero", artifacts: [{ id: "hero" }] })
    })

    it("does nothing once its terminal has closed", () => {
      const app = open()
      app.commands.undock("01", plan)
      const window = app.windows()[0]!.id
      app.commands.close("01")
      app.commands.dock(window)
      expect(app.windows().map((each) => each.id)).toEqual([window])
    })
  })

  context("when placing an item on another terminal's taskbar", () => {
    it("shows it there, last on that bar", () => {
      const app = open()
      app.panes.of(key("02")).update((pane) => ({ ...pane, order: ["mine"] }))
      app.commands.place([{ from: "01", item: image, to: "02" }])
      expect(app.state().placements).toEqual([{ from: "01", item: image, to: "02" }])
      expect(app.pane("02").order).toEqual(["mine", placedKey("01", image)])
    })

    it("puts it last again when placed there again after going home", () => {
      const app = open()
      app.commands.place([{ from: "01", item: image, to: "02" }])
      app.panes.of(key("02")).update((pane) => ({ ...pane, order: [...pane.order, "later"] }))
      app.commands.place([{ from: "01", item: image, to: "01" }])
      app.commands.place([{ from: "01", item: image, to: "02" }])
      expect(app.pane("02").order.at(-1)).toBe(placedKey("01", image))
    })

    it("sends it home, closed, when it's closed there", () => {
      const app = open()
      app.commands.place([{ from: "01", item: plan, to: "02" }])
      app.commands.closeItem("01", planTab("root"))
      expect(app.state().placements).toEqual([])
      expect(app.pane("01").closed).toEqual([planTab("root")])
    })

    it("places nothing on a window undocked from a terminal", () => {
      const app = open()
      app.commands.undock("01", plan)
      app.commands.place([{ from: "01", item: image, to: app.windows()[0]!.id }])
      expect(app.state().placements).toEqual([])
    })
  })

  context("when what a pane shows leaves its bar", () => {
    const showing = (app: ReturnType<typeof open>, id: string, tab: string) =>
      app.panes.of(key(id)).update((pane) => openTab(pane, tab))

    it("hides the pane, which stays hidden when the item comes back from its window", () => {
      const app = open()
      showing(app, "01", "hero")
      app.commands.undock("01", image)
      expect(app.pane("01").open).toBe(false)
      app.commands.close(app.windows()[0]!.id)
      expect(app.pane("01")).toMatchObject({ open: false, order: expect.arrayContaining(["hero"]) })
    })

    it("hides the pane it leaves, and the bar's it's sent home from", () => {
      const app = open()
      showing(app, "01", "hero")
      app.commands.place([{ from: "01", item: image, to: "02" }])
      expect(app.pane("01").open).toBe(false)
      showing(app, "02", placedKey("01", image))
      app.commands.place([{ from: "01", item: image, to: "01" }])
      expect(app.pane("02").open).toBe(false)
      expect(app.pane("01").open).toBe(false)
    })

    it("hides the bar's pane when the terminal it's from closes", () => {
      const app = open({ workspace: workspaceFixture({ terminals: 3 }) })
      app.commands.place([{ from: "01", item: image, to: "02" }])
      showing(app, "02", placedKey("01", image))
      app.commands.close("01")
      expect(app.pane("02").open).toBe(false)
    })

    it("hides the bar's pane when it's closed there", () => {
      const app = open()
      app.commands.place([{ from: "01", item: plan, to: "02" }])
      showing(app, "02", placedKey("01", plan))
      app.commands.closeItem("01", planTab("root"))
      expect(app.pane("02").open).toBe(false)
    })
  })

  it("closes the messages in their terminal's pane", () => {
    const app = open()
    app.panes.of(key("01")).update((pane) => ({ ...pane, order: [...pane.order, mailTab] }))
    app.commands.closeItem("01", mailTab)
    expect(app.pane("01").closed).toEqual([mailTab])
  })
})
