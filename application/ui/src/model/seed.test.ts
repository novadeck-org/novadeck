import { context, describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { initialGridLayouts } from "./layout/grid-placement"
import { workspaceFromSeed, WorkspaceSeedError, type WorkspaceSeed, viewOf } from "./seed"

const terminals = [terminalFixture(1, "~/one"), terminalFixture(2, "~/one")]
const canvasLayout = {
  minimized: {},
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
          sessions: [{ id: "initial", name: "Session", terminals, canvasLayout }],
        },
        {
          id: "two",
          name: "two",
          directory: "~/two",
          sessions: [{ id: "initial", name: "Session", terminals: [] }],
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
                { id: "latest", name: "Latest", terminals },
                { id: "older", name: "Older", terminals: [] },
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
            sessions: [{ id: "s", name: "S", terminals }],
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
            { id: "latest", name: "Latest", terminals: [...live, extra], restored, visitedAt: 30 },
            { id: "older", name: "Older", terminals: [], visitedAt: 10 },
          ],
        },
        {
          id: "two",
          name: "two",
          directory: "~/two",
          sessions: [{ id: "latest", name: "Two", terminals: [], visitedAt: 20 }],
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
              sessions: [{ id: "s", name: "S", terminals }],
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
              sessions: [{ id: "s", name: "S", terminals: [kept!], restored: view }],
            },
          ],
        },
        defaults,
      ).projects[0]!.history[0]!.state
      expect(seeded.roster).toEqual({ terminals: [kept], order: ["01"] })
      expect(seeded.selected).toBe("01")
      expect(seeded.layout.canvas.geometry).not.toHaveProperty("02")
      expect(
        Object.values(seeded.layout.grid)
          .flat()
          .some((item) => item?.i === "02"),
      ).toBe(false)
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
