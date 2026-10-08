import { context, describe, expect, it } from "../test"
import { itemFixture, terminalFixture } from "../test/fixtures"
import { itemIdOf } from "./companion"
import { messagesKey } from "./companion-bar"
import { initialGridLayouts } from "./layout/grid-placement"
import { workspaceFromSeed, WorkspaceSeedError, type WorkspaceSeed, viewOf } from "./seed"

const terminals = [terminalFixture(1, "~/one"), terminalFixture(2, "~/one")]
const canvasLayout = {
  geometry: { "01": { position: { x: 80, y: 80 }, width: 550, height: 400 } },
}
const defaults = { view: "focus", windowedView: "canvas", now: 1_000 } as const

describe("workspace from a backend seed", () => {
  context("with one session per project", () => {
    const seed: WorkspaceSeed = {
      projects: [
        {
          id: "one",
          name: "one",
          directory: "~/one",
          sessions: [
            { id: "initial", name: "Session", items: [], windows: [], terminals, canvasLayout },
          ],
        },
        {
          id: "two",
          name: "two",
          directory: "~/two",
          sessions: [{ id: "initial", name: "Session", items: [], windows: [], terminals: [] }],
        },
      ],
    }

    it("activates the first project and opens each project's seeded session", () => {
      const workspace = workspaceFromSeed(seed, defaults)
      expect(workspace.activeProjectId).toBe("one")
      expect(workspace.projects.map((project) => project.activeSessionId)).toEqual([
        "initial",
        "initial",
      ])
      expect(workspace.projects[0]).not.toHaveProperty("sessions")
    })

    it("starts sessions in the default views with saved and derived layouts", () => {
      const session = workspaceFromSeed(seed, defaults).projects[0]!.history[0]!
      expect(session).toMatchObject({ id: "initial", name: "Session", visitedAt: 1_000 })
      expect(session.state).toMatchObject({
        view: "focus",
        windowedView: "canvas",
        selected: "01",
        roster: { terminals, order: [] },
        layout: {
          canvas: canvasLayout,
          grid: initialGridLayouts(terminals, canvasLayout.geometry),
        },
      })
    })
  })

  context("with several sessions in a project", () => {
    it("opens the first listed session and keeps the listed order", () => {
      const workspace = workspaceFromSeed(
        {
          projects: [
            {
              id: "one",
              name: "one",
              directory: "~/one",
              sessions: [
                { id: "latest", name: "Latest", items: [], windows: [], terminals },
                { id: "older", name: "Older", items: [], windows: [], terminals: [] },
              ],
            },
          ],
        },
        defaults,
      )
      const project = workspace.projects[0]!
      expect(project.activeSessionId).toBe("latest")
      expect(project.history.map((session) => session.id)).toEqual(["latest", "older"])
    })
  })

  context("with a saved state and visit times", () => {
    const saved = workspaceFromSeed(
      {
        projects: [
          {
            id: "one",
            name: "one",
            directory: "~/one",
            sessions: [{ id: "s", name: "S", items: [], windows: [], terminals }],
          },
        ],
      },
      defaults,
    ).projects[0]!.history[0]!.state
    const restored = viewOf({
      ...saved,
      view: "canvas" as const,
      selected: "02",
      roster: { ...saved.roster, order: ["02", "01"] },
    })
    const live = terminals.map((terminal) => ({ ...terminal, state: "running" as const }))
    const extra = { ...terminalFixture(3, "~/one"), id: "extra", name: "Terminal 7" }
    const seed: WorkspaceSeed = {
      activeProjectId: "two",
      projects: [
        {
          id: "one",
          name: "one",
          directory: "~/one",
          sessions: [
            {
              id: "latest",
              name: "Latest",
              items: [],
              windows: [],
              terminals: [...live, extra],
              restored,
              visitedAt: 30,
            },
            { id: "older", name: "Older", items: [], windows: [], terminals: [], visitedAt: 10 },
          ],
        },
        {
          id: "two",
          name: "two",
          directory: "~/two",
          sessions: [
            { id: "latest", name: "Two", items: [], windows: [], terminals: [], visitedAt: 20 },
          ],
        },
      ],
    }
    const workspace = workspaceFromSeed(seed, defaults)
    const session = workspace.projects[0]!.history[0]!

    it("opens the seed's active project", () => {
      expect(workspace.activeProjectId).toBe("two")
    })

    it("keeps each session's visit time", () => {
      expect(
        workspace.projects.map((project) => project.history.map((item) => item.visitedAt)),
      ).toEqual([[30, 10], [20]])
    })

    it("restores the saved view, order and selection with the seeded metadata", () => {
      expect(session.state).toMatchObject({ view: "canvas", selected: "02" })
      expect(session.state.roster.order).toEqual(["02", "01"])
      expect(session.state.roster.terminals.slice(0, 2)).toEqual(live)
    })

    it("lays out terminals the saved state does not know after the saved ones", () => {
      expect(session.state.roster.terminals.at(-1)).toEqual(extra)
      expect(session.state.layout.canvas.geometry).toHaveProperty("extra")
      expect(session.state.layout.canvas.geometry["01"]).toEqual(saved.layout.canvas.geometry["01"])
    })
  })

  context("with a saved view of terminals the backend no longer has", () => {
    it("drops what it kept of them, and hands their selection on", () => {
      const state = workspaceFromSeed(
        {
          projects: [
            {
              id: "one",
              name: "one",
              directory: "~/one",
              sessions: [{ id: "s", name: "S", items: [], windows: [], terminals }],
            },
          ],
        },
        defaults,
      ).projects[0]!.history[0]!.state
      const view = viewOf({
        ...state,
        selected: "02",
        roster: { ...state.roster, order: ["02", "01"] },
      })
      const [kept] = terminals
      const seeded = workspaceFromSeed(
        {
          projects: [
            {
              id: "one",
              name: "one",
              directory: "~/one",
              sessions: [
                { id: "s", name: "S", items: [], windows: [], terminals: [kept!], restored: view },
              ],
            },
          ],
        },
        defaults,
      ).projects[0]!.history[0]!.state
      expect(seeded.roster).toEqual({ terminals: [kept], windows: [], order: ["01"] })
      expect(seeded.selected).toBe("01")
      expect(seeded.layout.canvas.geometry).not.toHaveProperty("02")
      expect(
        Object.values(seeded.layout.grid)
          .flat()
          .some((item) => item?.i === "02"),
      ).toBe(false)
    })
  })

  context("with companion items and windows", () => {
    const older = itemFixture("older", "01", { shownAt: 1 })
    const newer = itemFixture("newer", "01", { shownAt: 2 })
    const undocked = itemFixture("undocked", "02", { holder: { windowId: "w1" } })
    const window = {
      id: "w1",
      itemId: undocked.id,
      name: "undocked.ts",
      titleSource: { kind: "default" },
    } as const
    const seeded = (session: Partial<WorkspaceSeed["projects"][number]["sessions"][number]>) =>
      workspaceFromSeed(
        {
          projects: [
            {
              id: "one",
              name: "one",
              directory: "~/one",
              sessions: [
                {
                  id: "s",
                  name: "S",
                  terminals,
                  items: [newer, older, undocked],
                  windows: [window],
                  ...session,
                },
              ],
            },
          ],
        },
        defaults,
      ).projects[0]!.history[0]!.state

    it("lays the windows out after the terminals and puts items on their bars, oldest first", () => {
      const state = seeded({})
      expect(state.roster.windows).toEqual([window])
      expect(state.layout.canvas.geometry).toHaveProperty("w1")
      expect(state.items).toEqual([newer, older, undocked])
      expect(state.bars).toEqual({
        "01": { order: [older.id, newer.id], hidden: [], tab: null, open: false },
      })
    })

    it("marks nothing new", () => {
      expect(seeded({}).fresh).toEqual({})
    })

    it("keeps the saved bars, less what's gone, with what they didn't know after", () => {
      const view = viewOf({
        ...seeded({}),
        bars: {
          "01": {
            order: [itemIdOf("gone"), newer.id, messagesKey],
            hidden: [],
            tab: itemIdOf("gone"),
            open: true,
          },
          "99": { order: [newer.id], hidden: [], tab: null, open: false },
        },
      })
      const state = seeded({ restored: view })
      expect(state.bars).toEqual({
        "01": { order: [newer.id, messagesKey, older.id], hidden: [], tab: null, open: false },
      })
      expect(state.roster.windows).toEqual([window])
    })

    it("keeps items whose terminal or window isn't known, on no bar", () => {
      const elsewhere = itemFixture("x", "99")
      const state = seeded({ windows: [], items: [older, undocked, elsewhere] })
      expect(state.items).toEqual([older, undocked, elsewhere])
      expect(state.bars).toEqual({
        "01": { order: [older.id], hidden: [], tab: null, open: false },
      })
    })
  })

  context("with nothing to open", () => {
    it("rejects a seed without projects", () => {
      expect(() => workspaceFromSeed({ projects: [] }, defaults)).toThrow(WorkspaceSeedError)
    })

    it("rejects a project without sessions, naming the project", () => {
      const seed = { projects: [{ id: "one", name: "one", directory: "~/one", sessions: [] }] }
      expect(() => workspaceFromSeed(seed, defaults)).toThrow(/"one".*no session/)
    })
  })
})
