import type { ProjectWindows, ProjectWindowTarget } from "@novadeck/core/desktop/project-windows"
import type { TerminalRequest } from "@novadeck/core/port"
import { createTerminalState } from "@novadeck/core/state"
import { terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type { Workspace } from "@novadeck/core/types"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"

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
    swap: (id) => void asked.push(["swap", id]),
    handOff: (target) => void asked.push(["handOff", target]),
    onNavigate: () => () => {},
    extra: false,
  }
  return { windows, asked }
}

// An app with project windows on, whose other windows show `elsewhere`.
const opened = (elsewhere: string[], on = true) => {
  const { windows, asked } = recorded()
  const app = openCommands({ workspace: twoProjects(), windows })
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
    it("swaps the two windows' projects: the app is told, and this window shows the pick", () => {
      const { app, asked } = opened(["other"])
      app.commands.switchProject(project(app, "other"))
      expect(asked).toEqual([["swap", "other"]])
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
    })

    it("only switches for a project no other window shows", () => {
      const { app, asked } = opened([])
      app.commands.switchProject(project(app, "other"))
      expect(asked).toEqual([])
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
    })

    it("only switches while project windows are off", () => {
      const { app, asked } = opened(["other"], false)
      app.commands.switchProject(project(app, "other"))
      expect(asked).toEqual([])
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
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

    it("hands over a terminal with the Inbox row for it", () => {
      const { app, asked } = opened([])
      expect(app.commands.handOffTerminal("07", "row-1")).toBe(true)
      expect(asked).toEqual([["handOff", { projectId: "other", terminalId: "07", rowId: "row-1" }]])
    })

    it("hands over a row only when another window shows its project", () => {
      const { app, asked } = opened(["other"])
      expect(app.commands.handOffRow({ id: "row-1", terminalId: "07" })).toBe(true)
      expect(app.commands.handOffRow({ id: "row-2", terminalId: "01" })).toBe(false)
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
      expect(asked).toEqual([["handOff", { projectId: "other", terminalId: "new-2" }]])
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
    it("shows the project", () => {
      const { app } = opened([])
      app.commands.showProjectHere({ projectId: "other" })
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
    })

    it("reveals the terminal, without handing it on again", () => {
      const { app, asked } = opened(["other"])
      app.commands.showProjectHere({ projectId: "other", terminalId: "07" })
      expect(asked).toEqual([])
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
      expect(app.state().selected).toBe("07")
    })

    it("waits a moment for a terminal this window hasn't heard of, then reveals it", () => {
      vi.useFakeTimers()
      const { app } = opened([])
      const target: ProjectWindowTarget = { projectId: "other", terminalId: "08" }
      app.commands.showProjectHere(target)
      expect(app.workspace.getSnapshot().activeProjectId).toBe("other")
      app.workspace.dispatch({
        type: "terminal/add",
        target: { projectId: "other", workspaceSessionId: "other-session" },
        terminal: { ...terminalFixture(8, "~/other") },
        select: false,
      })
      expect(app.state().selected).toBe("08")
    })

    it("does nothing for a project this window has never heard of", () => {
      const { app } = opened([])
      app.commands.showProjectHere({ projectId: "unknown" })
      expect(app.workspace.getSnapshot().activeProjectId).toBe("project")
    })
  })

  context("when the person opens a project in a new window", () => {
    it("asks the app, with project windows on", () => {
      const { app, asked } = opened([])
      app.commands.openInNewWindow("other")
      expect(asked).toEqual([["open", "other"]])
    })

    it("asks nothing with them off", () => {
      const { app, asked } = opened([], false)
      app.commands.openInNewWindow("other")
      expect(asked).toEqual([])
    })
  })
})
