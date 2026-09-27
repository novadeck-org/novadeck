import { context, describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { initialGridLayouts } from "./layout/grid-placement"
import { workspaceFromSeed, WorkspaceSeedError, type WorkspaceSeed } from "./seed"

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
        roster: { terminals, order: [], nextNumber: 3 },
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
