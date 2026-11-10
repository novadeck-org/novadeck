import type { Backend, TerminalMoveResult } from "@novadeck/core/port"
import { workspaceFixture } from "@novadeck/core/testing"
import type { TerminalKey, Workspace } from "@novadeck/core/types"

import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"

type Move = { key: TerminalKey; sessionId: string; undo: unknown }

// A backend's move that answers as the runner would, noting each call.
const recordingMove = (left: string | null = null) => {
  const calls: Move[] = []
  const move: NonNullable<Backend["moveTerminal"]> = async (key, sessionId, undo) => {
    calls.push({ key, sessionId, undo })
    const result: TerminalMoveResult = {
      sessionId,
      moved: [{ terminalId: key.terminalId, handle: "wren", was: "glint" }],
      left,
    }
    return result
  }
  return { calls, move }
}

// Two sessions: on screen, 01 leads 02; the other, "Payments", holds nothing.
const teamWorkspace = (): Workspace => {
  const base = workspaceFixture({ sessions: ["initial", "other"] })
  const project = base.projects[0]!
  const [here, there] = project.history
  const [lead, worker] = here!.state.roster.terminals
  return {
    ...base,
    projects: [
      {
        ...project,
        history: [
          {
            ...here!,
            state: {
              ...here!.state,
              roster: {
                ...here!.state.roster,
                terminals: [
                  { ...lead!, handle: "lynx" },
                  { ...worker!, handle: "glint", ledBy: "lynx" },
                ],
              },
            },
          },
          {
            ...there!,
            name: "Payments",
            state: { ...there!.state, roster: { terminals: [], windows: [], order: [] } },
          },
        ],
      },
    ],
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("moving a terminal to another session", () => {
  context("when it leads its team or has no lead", () => {
    it("asks the backend at once, and the toast says where it went", async () => {
      const { calls, move } = recordingMove()
      const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
      app.commands.moveTerminal("01", { sessionId: "other" })
      await settle()
      expect(calls.map((call) => [call.key.terminalId, call.sessionId])).toEqual([["01", "other"]])
      expect(app.ui.getSnapshot().moved).toMatchObject({
        terminalId: "01",
        session: { id: "other", name: "Payments" },
        from: "initial",
      })
    })

    it("makes a session named after it first, for a new one", async () => {
      const { calls, move } = recordingMove()
      const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
      app.commands.moveTerminal("01", { fresh: true })
      await settle()
      const sessions = app.workspace.getSnapshot().projects[0]!.history
      const made = sessions.find((session) => session.name === "Terminal")
      expect(made).toBeDefined()
      expect(calls[0]?.sessionId).toBe(made!.id)
      // The person stays where they were.
      expect(app.workspace.getSnapshot().projects[0]!.activeSessionId).toBe("initial")
    })
  })

  context("when it is a teammate", () => {
    it("asks the person first, and moving the whole team moves its lead", async () => {
      const { calls, move } = recordingMove()
      const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
      app.commands.moveTerminal("02", { sessionId: "other" })
      expect(app.ui.getSnapshot().moveAsk).toMatchObject({ terminalId: "02" })
      expect(calls).toEqual([])
      app.commands.confirmMove("team")
      await settle()
      expect(calls.map((call) => call.key.terminalId)).toEqual(["01"])
    })

    it("moves alone when told, and its undo takes back the handle and the lead", async () => {
      const { calls, move } = recordingMove("lynx")
      const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
      app.commands.moveTerminal("02", { sessionId: "other" })
      app.commands.confirmMove("alone")
      await settle()
      const notice = app.ui.getSnapshot().moved!
      app.commands.undoMove(notice)
      await settle()
      expect(calls[1]).toMatchObject({
        key: { workspaceSessionId: "other", terminalId: "02" },
        sessionId: "initial",
        undo: { handles: { "02": "glint" }, lead: "lynx" },
      })
    })

    it("stays where it is when the person cancels", () => {
      const { calls, move } = recordingMove()
      const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
      app.commands.moveTerminal("02", { sessionId: "other" })
      app.commands.cancelMove()
      expect(app.ui.getSnapshot().moveAsk).toBeNull()
      expect(calls).toEqual([])
    })
  })

  context("when the person picks where in the Sessions panel", () => {
    it("shows the panel, and goes back to the terminals once it moved", async () => {
      const { move } = recordingMove()
      const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
      app.commands.pickSession("01", "menu")
      expect(app.ui.getSnapshot().location.route.panel).toBe("sessions")
      expect(app.ui.getSnapshot().moving).toMatchObject({ terminalId: "01", via: "menu" })
      app.commands.moveTerminal("01", { sessionId: "other" })
      expect(app.ui.getSnapshot().moving).toBeNull()
      expect(app.ui.getSnapshot().location.route.panel).toBe("terminals")
    })
  })

  context("when a pick from the menu ends", () => {
    const shell = (app: ReturnType<typeof openCommands>) => app.shell()
    const panel = (app: ReturnType<typeof openCommands>) =>
      app.ui.getSnapshot().location.route.panel

    it("puts back the panel the sidebar showed, when it gives up", () => {
      const { move } = recordingMove()
      const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
      app.commands.showInbox()
      app.commands.pickSession("01", "menu")
      expect(panel(app)).toBe("sessions")
      app.commands.cancelPick()
      expect(panel(app)).toBe("inbox")
    })

    it("hides the sidebar again where it was hidden", () => {
      const { move } = recordingMove()
      const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
      app.commands.hideSidebar()
      app.commands.pickSession("01", "menu")
      expect(shell(app)).toMatchObject({ sidebarCollapsed: false })
      app.commands.moveTerminal("01", { sessionId: "other" })
      expect(shell(app)).toMatchObject({ sidebarCollapsed: true })
      expect(panel(app)).toBe("terminals")
    })

    it("goes back to Zen", () => {
      const { move } = recordingMove()
      const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
      app.commands.enterZen()
      const zen = shell(app).zen
      app.commands.pickSession("01", "menu")
      expect(shell(app).zen).toBeNull()
      app.commands.cancelPick()
      expect(shell(app).zen).toEqual(zen)
    })

    it("leaves the Sessions panel showing where it showed already", () => {
      const { move } = recordingMove()
      const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
      app.commands.showSessions()
      app.commands.pickSession("01", "menu")
      app.commands.cancelPick()
      expect(panel(app)).toBe("sessions")
    })
  })

  it("tells why a move the backend refused didn't happen", async () => {
    const app = openCommands({
      workspace: teamWorkspace(),
      moveTerminal: () => Promise.reject(new Error("It's closing.")),
    })
    app.commands.moveTerminal("01", { sessionId: "other" })
    await settle()
    expect(app.ui.getSnapshot().moved).toMatchObject({ failed: "It's closing." })
  })

  it("takes back the session it made for a new one that the backend refused", async () => {
    const app = openCommands({
      workspace: teamWorkspace(),
      moveTerminal: () => Promise.reject(new Error("It's closing.")),
    })
    app.commands.moveTerminal("01", { fresh: true })
    await settle()
    const sessions = app.workspace.getSnapshot().projects[0]!.history
    expect(sessions.map((session) => session.id)).toEqual(["initial", "other"])
    expect(app.ui.getSnapshot().moved).toMatchObject({ failed: "It's closing.", fresh: true })
  })

  it("ends a pick once the Sessions panel is left", () => {
    const { move } = recordingMove()
    const app = openCommands({ workspace: teamWorkspace(), moveTerminal: move })
    app.commands.pickSession("01", "menu")
    expect(app.ui.getSnapshot().moving).not.toBeNull()
    app.commands.showTerminals()
    expect(app.ui.getSnapshot().moving).toBeNull()
    app.commands.showSessions()
    expect(app.ui.getSnapshot().moving).toBeNull()
  })
})
