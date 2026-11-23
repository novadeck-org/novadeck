import type { ProjectWindows, ProjectWindowTarget } from "@novadeck/core/desktop/project-windows"
import type { TerminalRequest } from "@novadeck/core/port"
import type { ProjectSeed } from "@novadeck/core/seed"
import { createTerminalState } from "@novadeck/core/state"
import { terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type { Workspace } from "@novadeck/core/types"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import type { CommandContext } from "./context"

afterEach(() => void vi.useRealTimers())

// The fixture's Project, with terminals 01 and 02, and Other beside it, with terminal 07.
const twoProjects = (): Workspace => {
  const workspace = workspaceFixture()
  const [first] = workspace.projects
  return {
    ...workspace,
    projects: [
      first!,
      {
        ...first!,
        id: "other",
        name: "Other",
        directory: "~/other",
        activeSessionId: "other-session",
        history: [
          {
            id: "other-session",
            name: "initial",
            visitedAt: 0,
            state: createTerminalState([terminalFixture(7, "~/other")], "grid", "grid"),
          },
        ],
      },
    ],
  }
}

// What the page asks of the app's windows, recorded.
const recorded = () => {
  const asked: [string, ...unknown[]][] = []
  const windows: ProjectWindows = {
    onState: () => () => {},
    show: () => {},
    use: () => {},
    open: (id) => void asked.push(["open", id]),
    handOff: (target) => void asked.push(["handOff", target]),
    onNavigate: () => () => {},
    extra: false,
  }
  return { windows, asked }
}

// An app with project windows on, whose other windows show `elsewhere`.
const opened = (elsewhere: string[], on = true, syncProject?: CommandContext["syncProject"]) => {
  const { windows, asked } = recorded()
  const app = openCommands({
    workspace: twoProjects(),
    windows,
    ...(syncProject && { syncProject }),
  })
  app.ui.update((state) => ({
    ...state,
    flags: { IS_EXPERIMENTAL: on },
    preferences: { ...state.preferences, projectWindows: on },
    windows: { elsewhere, voice: true },
  }))
  return { app, asked }
}

const project = (app: ReturnType<typeof openCommands>, id: string) =>
  app.workspace.getSnapshot().projects.find((each) => each.id === id)!

describe("project windows", () => {
  context("when the person picks a project another window shows", () => {
    it("shows it here, asks the app nothing, and leaves the other window alone", async () => {
      const { app, asked } = opened(["other"])
      app.commands.switchProject(project(app, "other"))
      await vi.waitFor(() => expect(app.workspace.getSnapshot().activeProjectId).toBe("other"))
      expect(asked).toEqual([])
    })

    it("shows it here for a project no other window shows, or with project windows off", () => {
      for (const on of [true, false]) {
        const { app, asked } = opened(on ? [] : ["other"], on)
        app.commands.switchProject(project(app, "other"))
        expect(asked).toEqual([])
        expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
      }
    })
  })

  context("when something is about a terminal of a project another window shows", () => {
    it("hands it to that window, and leaves this one as it is", () => {
      const { app, asked } = opened(["other"])
      const before = app.ui.getSnapshot().location.route
      app.commands.reveal("07")
      expect(asked).toEqual([["handOff", { projectId: "other", terminalId: "07" }]])
      expect(app.workspace.getSnapshot().activeProjectId).toBe("project")
      expect(app.ui.getSnapshot().location.route).toEqual(before)
    })

    it("switches this window to it when no window shows its project, as before", () => {
      const { app, asked } = opened([])
      app.commands.reveal("07")
      expect(asked).toEqual([])
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
    })

    it("hands over a terminal with the Inbox entry for it", () => {
      const { app, asked } = opened([])
      expect(app.commands.handOffTerminal("07", "row-1")).toBe(true)
      expect(asked).toEqual([["handOff", { projectId: "other", terminalId: "07", rowId: "row-1" }]])
    })

    it("keeps what is about the project this window shows here, even when another shows it too", () => {
      const { app, asked } = opened(["project"])
      app.commands.reveal("01")
      expect(app.commands.handOffEntry({ id: "row-1", terminalId: "01" })).toBe(false)
      expect(asked).toEqual([])
    })

    it("hands over an entry only when another window shows its project and this one does not", () => {
      const { app, asked } = opened(["other"])
      expect(app.commands.handOffEntry({ id: "row-1", terminalId: "07" })).toBe(true)
      expect(app.commands.handOffEntry({ id: "row-2", terminalId: "01" })).toBe(false)
      expect(asked).toEqual([["handOff", { projectId: "other", terminalId: "07", rowId: "row-1" }]])
    })
  })

  context("when an agent asks to open a terminal and show it", () => {
    const request = (from: string): TerminalRequest => ({
      from,
      directory: "~/other",
      focus: true,
      answer: () => {},
    })

    it("hands the new terminal to the window that shows its project", () => {
      const { app, asked } = opened(["other"])
      app.commands.openRequested(request("07"))
      expect(asked).toEqual([["handOff", { projectId: "other", terminalId: "new-2", quiet: true }]])
      expect(app.workspace.getSnapshot().activeProjectId).toBe("project")
      expect(project(app, "other").history[0]!.state.roster.terminals).toHaveLength(2)
    })

    it("brings it into view here when no window shows its project", () => {
      const { app, asked } = opened([])
      app.commands.openRequested(request("07"))
      expect(asked).toEqual([])
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
    })
  })

  context("when another window sends this one somewhere", () => {
    it("shows the project", async () => {
      const { app } = opened([])
      await app.commands.showProjectHere({ projectId: "other" })
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
    })

    it("reveals the terminal, without handing it on again", async () => {
      const { app, asked } = opened(["other"])
      await app.commands.showProjectHere({ projectId: "other", terminalId: "07" })
      expect(asked).toEqual([])
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
      expect(app.state().selected).toBe("07")
    })

    it("waits a moment for a terminal this window hasn't heard of, then reveals it", async () => {
      vi.useFakeTimers()
      const { app } = opened([])
      const target: ProjectWindowTarget = { projectId: "other", terminalId: "08" }
      await app.commands.showProjectHere(target)
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
      app.workspace.dispatch({
        type: "terminal/add",
        target: { projectId: "other", workspaceSessionId: "other-session" },
        terminal: { ...terminalFixture(8, "~/other") },
        select: false,
      })
      expect(app.state().selected).toBe("08")
    })

    it("does nothing for a project this window has never heard of", async () => {
      const { app } = opened([])
      await app.commands.showProjectHere({ projectId: "unknown" })
      expect(app.workspace.getSnapshot().activeProjectId).toBe("project")
    })
  })

  context("when the person opens a project in a new window", () => {
    it("asks the app, with project windows on", () => {
      const { app, asked } = opened([])
      app.commands.openInNewWindow("other")
      expect(asked).toEqual([["open", "other"]])
    })

    it("asks the app for the project this window shows too", () => {
      const { app, asked } = opened(["project"])
      app.commands.openInNewWindow("project")
      expect(asked).toEqual([["open", "project"]])
    })

    it("asks nothing with them off", () => {
      const { app, asked } = opened([], false)
      app.commands.openInNewWindow("other")
      expect(asked).toEqual([])
    })
  })

  context("when this window takes on a project from another window", () => {
    // The runner's copy of Other: one terminal, 09, which this window never heard of.
    const reread = (): ProjectSeed => ({
      id: "other",
      name: "Other",
      directory: "~/other",
      sessions: [
        {
          id: "other-session",
          name: "initial",
          terminals: [terminalFixture(9, "~/other")],
          windows: [],
          items: [],
        },
      ],
    })

    it("reads the project another window shows too, and then shows it", async () => {
      const read: string[] = []
      const { app, asked } = opened(["other"], true, async (id) => {
        read.push(id)
        return reread()
      })
      app.commands.switchProject(project(app, "other"))
      await vi.waitFor(() => expect(app.workspace.getSnapshot().activeProjectId).toBe("other"))
      expect(read).toEqual(["other"])
      expect(asked).toEqual([])
      expect(
        project(app, "other").history[0]!.state.roster.terminals.map((each) => each.id),
      ).toEqual(["09"])
    })

    it("ends on the latest pick when an earlier pick's reading finishes last", async () => {
      const releases = new Map<string, () => void>()
      const { app } = opened([], true, (id) => {
        return new Promise((resolve) =>
          releases.set(id, () => resolve({ ...reread(), id, name: id })),
        )
      })
      app.commands.switchProject({ id: "first", name: "First", directory: "~/first" })
      app.commands.switchProject({ id: "second", name: "Second", directory: "~/second" })
      await vi.waitFor(() => expect(releases.size).toBe(2))
      releases.get("second")!()
      await vi.waitFor(() => expect(app.workspace.getSnapshot().activeProjectId).toBe("second"))
      releases.get("first")!()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(app.workspace.getSnapshot().activeProjectId).toBe("second")
    })

    it("carries on with the copy it has when the project can't be built, and logs it", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {})
      const { app } = opened([], true, async () => ({
        id: "other",
        name: "Other",
        directory: "~/other",
        sessions: [],
      }))
      app.commands.switchProject(project(app, "other"))
      await vi.waitFor(() => expect(app.workspace.getSnapshot().activeProjectId).toBe("other"))
      expect(log).toHaveBeenCalled()
      log.mockRestore()
    })

    it("never reads the project it shows over its live copy", async () => {
      const read: string[] = []
      const { app } = opened([], true, async (id) => {
        read.push(id)
        return reread()
      })
      await app.commands.readProject("project")
      await app.commands.showProjectHere({ projectId: "project" })
      expect(read).toEqual([])
    })

    it("reads a project nobody shows at once", async () => {
      const read: string[] = []
      const { app } = opened([], true, async (id) => {
        read.push(id)
        return reread()
      })
      app.commands.switchProject(project(app, "other"))
      await vi.waitFor(() => expect(read).toEqual(["other"]))
      await vi.waitFor(() => expect(app.workspace.getSnapshot().activeProjectId).toBe("other"))
    })

    it("learns a project made in another window, and shows it, when sent there, without a reload", async () => {
      const { app } = opened([], true, async () => ({ ...reread(), id: "brand-new", name: "New" }))
      await app.commands.showProjectHere({ projectId: "brand-new" })
      expect(app.workspace.getSnapshot().activeProjectId).toBe("brand-new")
    })

    it("reveals a terminal the runner now holds, read just before, without waiting for it", async () => {
      const { app } = opened([], true, async () => reread())
      await app.commands.showProjectHere({ projectId: "other", terminalId: "09" })
      expect(app.state().selected).toBe("09")
    })

    it("carries on with what it has when the runner can't be read", async () => {
      const { app } = opened([], true, () => Promise.reject(new Error("link down")))
      const log = vi.spyOn(console, "error").mockImplementation(() => {})
      await app.commands.showProjectHere({ projectId: "other" })
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
      log.mockRestore()
    })

    it("does not read it with project windows off", () => {
      const read: string[] = []
      const { app } = opened([], false, async (id) => {
        read.push(id)
        return reread()
      })
      app.commands.switchProject(project(app, "other"))
      expect(read).toEqual([])
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
    })
  })
})
