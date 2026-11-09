import type { ClosedTerminal } from "@novadeck/core/history"
import type { TerminalRequest } from "@novadeck/core/port"
import { orderedTiles } from "@novadeck/core/roster"
import { createStore } from "@novadeck/core/store"
import { appearance, itemFixture, terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type { TerminalMetadata } from "@novadeck/core/types"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import { keyState } from "./keys"

const terminal = (app: ReturnType<typeof openCommands>, id: string) =>
  app.state().roster.terminals.find((item) => item.id === id)!

afterEach(() => void vi.useRealTimers())

// The fixture's project and two folders opened after it, as ids in the runner's order.
const three = async () => {
  const folders = ["/work/storefront/", "/work/blog/"]
  const app = openCommands({ pickDirectory: () => Promise.resolve(folders.shift()!) })
  await app.commands.openFolder()
  await app.commands.openFolder()
  const ids = app.workspace.getSnapshot().projects.map((each) => each.id)
  return { app, ids, arrangement: () => app.ui.getSnapshot().projectArrangement }
}

// A workspace whose first terminal runs a program.
const running = () => {
  const workspace = workspaceFixture()
  const state = workspace.projects[0]!.history[0]!.state
  const { id, name, directory, command } = state.roster.terminals[0]!
  state.roster.terminals[0] = {
    id,
    name,
    directory,
    command,
    state: "running",
    process: "vim",
  }
  return workspace
}

// Four idle terminals: 01 (@lynx) leads 02 (@glint) and 04; 02 leads 03.
const withTeam = () => {
  const workspace = workspaceFixture({ terminals: 4 })
  const state = workspace.projects[0]!.history[0]!.state
  const parts: Partial<TerminalMetadata>[] = [
    { handle: "lynx" },
    { handle: "glint", ledBy: "lynx" },
    { ledBy: "glint" },
    { ledBy: "lynx" },
  ] as never
  state.roster.terminals.forEach((each, index) => {
    state.roster.terminals[index] = { ...each, state: "idle", ...parts[index] } as TerminalMetadata
  })
  return workspace
}

// A request from an agent in terminal 02, unless it says otherwise, noting its answers.
const asking = (request: Partial<TerminalRequest> = {}) => {
  const answers: unknown[] = []
  const asked: TerminalRequest = {
    from: "02",
    directory: "/work/app",
    command: "claude",
    focus: false,
    answer: (result) => answers.push(result),
    ...request,
  }
  return { asked, answers }
}

// Two sessions; the one in the background holds terminal 09.
const twoSessions = () => {
  const workspace = workspaceFixture({ sessions: ["initial", "other"] })
  const other = workspace.projects[0]!.history[1]!.state
  other.roster.terminals.push(terminalFixture(9, "~/project"))
  return workspace
}

describe("workspace commands", () => {
  context("when adding a terminal while another is being renamed", () => {
    it("saves the rename in progress and puts typing focus in the new terminal", () => {
      const app = openCommands()
      app.commands.startRename(terminal(app, "01"), "sidebar")
      app.commands.changeRenameDraft("01", "Server")
      const id = app.commands.add()
      expect(terminal(app, "01").name).toBe("Server")
      expect(app.ui.getSnapshot().rename).toBeNull()
      expect(app.shell().keyboardFocus).toEqual({ id, view: app.state().view })
      expect(app.state().selected).toBe(id)
    })
  })

  context("when the person hands a terminal's name back", () => {
    it("calls off its rename in progress, unsaved, and asks the backend", () => {
      const reset: unknown[] = []
      const app = openCommands({ resetTitle: (key) => reset.push(key) })
      app.commands.startRename(terminal(app, "01"), "sidebar")
      app.commands.changeRenameDraft("01", "Half typed")
      app.commands.resetTitle("01")
      expect(app.ui.getSnapshot().rename).toBeNull()
      expect(terminal(app, "01").name).not.toBe("Half typed")
      expect(reset).toEqual([
        { projectId: "project", workspaceSessionId: "initial", terminalId: "01" },
      ])
    })

    it("leaves another terminal's rename alone", () => {
      const app = openCommands({ resetTitle: () => {} })
      app.commands.startRename(terminal(app, "02"), "sidebar")
      app.commands.resetTitle("01")
      expect(app.ui.getSnapshot().rename).toMatchObject({ id: "02" })
    })

    it("does nothing where the backend can't", () => {
      const app = openCommands()
      app.commands.startRename(terminal(app, "01"), "sidebar")
      app.commands.resetTitle("01")
      expect(app.ui.getSnapshot().rename).toMatchObject({ id: "01" })
    })
  })

  context("when adding a terminal from the keyboard", () => {
    it("opens the collapsed sidebar without renaming the terminal", () => {
      const app = openCommands()
      app.commands.hideSidebar()
      const id = app.commands.add({ fromKeyboard: true })
      expect(app.shell().sidebarCollapsed).toBe(false)
      expect(app.ui.getSnapshot().rename).toBeNull()
      expect(app.shell().keyboardFocus?.id).toBe(id)
      expect(app.ui.getSnapshot().location.route.panel).toBe("terminals")
    })
  })

  context("when a terminal was just created", () => {
    it("highlights it for 900 ms", () => {
      vi.useFakeTimers()
      const app = openCommands()
      const id = app.commands.add()
      expect(app.ui.getSnapshot().created).toEqual({ context: "project/initial", id })
      vi.advanceTimersByTime(899)
      expect(app.ui.getSnapshot().created).not.toBeNull()
      vi.advanceTimersByTime(1)
      expect(app.ui.getSnapshot().created).toBeNull()
    })
  })

  context("when starting a fresh session twice in the same minute", () => {
    it("numbers the second one and shows the Terminals panel", () => {
      const app = openCommands()
      app.commands.startFresh()
      app.commands.startFresh()
      const [second, first] = app.workspace.getSnapshot().projects[0]!.history
      expect(second!.name).toBe(`${first!.name} (2)`)
      expect(app.ui.getSnapshot().location.route).toMatchObject({
        sessionId: second!.id,
        panel: "terminals",
      })
      // The phone drawer opens on the session just created.
      expect(app.shell()).toMatchObject({
        freshSession: null,
        sidebar: true,
        sidebarCollapsed: false,
      })
      app.flush()
      expect(app.effects).toContain("focus terminals create")
    })
  })

  context("when opening a folder", () => {
    it("adds a project named after it with a fresh session and switches to it", async () => {
      const app = openCommands({ pickDirectory: () => Promise.resolve("/work/storefront/") })
      await app.commands.openFolder()
      const snapshot = app.workspace.getSnapshot()
      const opened = snapshot.projects.at(-1)!
      expect(opened).toMatchObject({ name: "storefront", directory: "/work/storefront/" })
      expect(opened.history).toHaveLength(1)
      expect(snapshot.activeProjectId).toBe(opened.id)
      expect(app.ui.getSnapshot().location.route).toMatchObject({
        projectId: opened.id,
        sessionId: opened.history[0]!.id,
      })
    })

    it("switches to the project a folder is already open as", async () => {
      const app = openCommands({ pickDirectory: () => Promise.resolve("/work/api") })
      await app.commands.openFolder()
      const first = app.workspace.getSnapshot()
      app.commands.switchProject(first.projects[0]!)
      await app.commands.openFolder()
      const snapshot = app.workspace.getSnapshot()
      expect(snapshot.projects).toHaveLength(first.projects.length)
      expect(snapshot.activeProjectId).toBe(first.activeProjectId)
    })

    it("changes nothing when the picker fails", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      const app = openCommands({ pickDirectory: () => Promise.reject(new Error("no dialog")) })
      const before = app.workspace.getSnapshot()
      await expect(app.commands.openFolder()).resolves.toBeUndefined()
      expect(app.workspace.getSnapshot()).toBe(before)
      expect(error).toHaveBeenCalled()
    })

    it("changes nothing when the person cancels", async () => {
      const app = openCommands({ pickDirectory: () => Promise.resolve(null) })
      const before = app.workspace.getSnapshot()
      await app.commands.openFolder()
      expect(app.workspace.getSnapshot()).toBe(before)
    })
  })

  context("when removing a project", () => {
    it("removes the open one and opens another, routing to it", async () => {
      const app = openCommands({ pickDirectory: () => Promise.resolve("/work/storefront/") })
      await app.commands.openFolder()
      const opened = app.workspace.getSnapshot().activeProjectId
      app.commands.removeProject(opened)
      const snapshot = app.workspace.getSnapshot()
      expect(snapshot.projects.map((each) => each.id)).toEqual(["project"])
      expect(snapshot.activeProjectId).toBe("project")
      expect(app.ui.getSnapshot().location.route).toMatchObject({ projectId: "project" })
    })

    it("keeps the last project", () => {
      const app = openCommands()
      const before = app.workspace.getSnapshot()
      app.commands.removeProject("project")
      expect(app.workspace.getSnapshot()).toBe(before)
    })
  })

  context("when arranging projects", () => {
    it("pins a project, then unpins it", async () => {
      const { app, ids, arrangement } = await three()
      app.commands.toggleProjectPin(ids[2]!)
      expect(arrangement().pinned).toEqual([ids[2]])
      app.commands.toggleProjectPin(ids[2]!)
      expect(arrangement().pinned).toEqual([])
    })

    it("moves a project to a place in the list", async () => {
      const { app, ids, arrangement } = await three()
      app.commands.moveProject(ids[2]!, 0)
      expect(arrangement()).toEqual({ order: [ids[2], ids[0], ids[1]], pinned: [] })
    })

    it("steps a project, pinning it in place on the way up from the top", async () => {
      const { app, ids, arrangement } = await three()
      app.commands.stepProject(ids[1]!, -1)
      expect(arrangement().order).toEqual([ids[1], ids[0], ids[2]])
      app.commands.stepProject(ids[1]!, -1)
      expect(arrangement().pinned).toEqual([ids[1]])
    })

    it("keeps the arrangement when nothing changes", async () => {
      const { app, ids, arrangement } = await three()
      const before = arrangement()
      app.commands.stepProject(ids[2]!, 1)
      app.commands.moveProject("gone", 0)
      app.commands.toggleProjectPin("gone")
      expect(arrangement()).toBe(before)
    })
  })

  context("when closing a terminal a program runs in", () => {
    it("asks first and keeps the terminal until the person answers", () => {
      const app = openCommands({ workspace: running() })
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toMatchObject({ id: "01" })
      expect(terminal(app, "01")).toBeDefined()
    })

    it("keeps it when the person cancels", () => {
      const app = openCommands({ workspace: running() })
      app.commands.close("01")
      app.commands.cancelClose()
      expect(app.ui.getSnapshot().closing).toBeNull()
      expect(terminal(app, "01")).toBeDefined()
    })

    it("closes it once the person confirms", () => {
      const app = openCommands({ workspace: running() })
      app.commands.close("01")
      app.commands.confirmClose()
      expect(app.ui.getSnapshot().closing).toBeNull()
      expect(app.state().roster.terminals.map((item) => item.id)).not.toContain("01")
    })

    it("does not close it after the session changed", () => {
      const app = openCommands({ workspace: running() })
      app.commands.close("01")
      app.commands.startFresh()
      app.commands.confirmClose()
      expect(
        app.workspace
          .getSnapshot()
          .projects[0]!.history.some((session) =>
            session.state.roster.terminals.some((item) => item.id === "01"),
          ),
      ).toBe(true)
    })

    it("drops the question when the person leaves the session", () => {
      const app = openCommands({ workspace: running() })
      app.commands.close("01")
      app.commands.startFresh()
      expect(app.ui.getSnapshot().closing).toBeNull()
    })

    it("drops the question when the terminal goes away on its own", () => {
      const app = openCommands({ workspace: running() })
      app.commands.close("01")
      app.workspace.dispatch({
        type: "terminal/close",
        target: { projectId: "project", workspaceSessionId: "initial" },
        terminalId: "01",
      })
      expect(app.ui.getSnapshot().closing).toBeNull()
      expect(keyState(app.context, app.commands)).toMatchObject({ dialog: false, alert: false })
    })

    it("counts as an alert that holds every shortcut back", () => {
      const app = openCommands({ workspace: running() })
      app.commands.close("01")
      expect(keyState(app.context, app.commands)).toMatchObject({ dialog: true, alert: true })
    })

    it("asks first for a sleeping agent too, since closing ends its saved session", () => {
      const workspace = running()
      const state = workspace.projects[0]!.history[0]!.state
      const { id, name, directory, command } = state.roster.terminals[0]!
      state.roster.terminals[0] = {
        id,
        name,
        directory,
        command,
        process: "",
        state: "sleeping",
        agent: "claude",
      }
      const app = openCommands({ workspace })
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toMatchObject({ id: "01" })
      expect(terminal(app, "01")).toBeDefined()
    })

    it("asks first while an agent wakes, since closing ends its saved session", () => {
      const workspace = running()
      const state = workspace.projects[0]!.history[0]!.state
      const { id, name, directory, command } = state.roster.terminals[0]!
      state.roster.terminals[0] = {
        id,
        name,
        directory,
        command,
        process: "",
        state: "starting",
        restoredProcess: "claude",
      }
      const app = openCommands({ workspace })
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toMatchObject({ id: "01" })
      expect(terminal(app, "01")).toBeDefined()
    })

    it("closes an idle terminal without asking", () => {
      const app = openCommands()
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toBeNull()
      expect(app.state().roster.terminals.map((item) => item.id)).not.toContain("01")
    })
  })

  context("when closing a terminal that leads a team", () => {
    const remaining = (app: ReturnType<typeof openCommands>) =>
      app.state().roster.terminals.map((item) => item.id)

    it("asks first, though nothing runs in it and its team is not running", () => {
      const app = openCommands({ workspace: withTeam() })
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toMatchObject({ id: "01" })
      expect(remaining(app)).toContain("01")
    })

    it("asks first where the backend keeps History too", () => {
      const history = { state: createStore({ rows: [] }), list: () => Promise.resolve([]) }
      const app = openCommands({ workspace: withTeam(), history })
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toMatchObject({ id: "01" })
    })

    it("asks of a sub-lead, and closes a teammate that leads no one without asking", () => {
      const app = openCommands({ workspace: withTeam() })
      app.commands.close("04")
      expect(app.ui.getSnapshot().closing).toBeNull()
      app.commands.close("02")
      expect(app.ui.getSnapshot().closing).toMatchObject({ id: "02" })
    })

    it("closes the lead and everyone below it, at any depth, when the person closes all", () => {
      const app = openCommands({ workspace: withTeam() })
      app.commands.close("01")
      app.commands.confirmClose("team")
      expect(remaining(app)).toEqual([])
    })

    it("closes only the lead when the person closes it alone", () => {
      const app = openCommands({ workspace: withTeam() })
      app.commands.close("01")
      app.commands.confirmClose("terminal")
      expect(remaining(app)).toEqual(["02", "03", "04"])
    })

    it("closes a sub-lead with its own team and leaves the rest", () => {
      const app = openCommands({ workspace: withTeam() })
      app.commands.close("02")
      app.commands.confirmClose("team")
      expect(remaining(app)).toEqual(["01", "04"])
    })
  })

  context("when the backend keeps closed terminals", () => {
    const history = { state: createStore({ rows: [] }), list: () => Promise.resolve([]) }
    // The first terminal, with what the runner says of it.
    const asBackendSays = (parts: Partial<TerminalMetadata>) => {
      const workspace = workspaceFixture()
      const state = workspace.projects[0]!.history[0]!.state
      state.roster.terminals[0] = { ...state.roster.terminals[0]!, ...parts } as TerminalMetadata
      return openCommands({ workspace, history })
    }

    it("asks while a program runs in the shell, which Windows says only as busy", () => {
      const app = asBackendSays({ state: "idle", busy: true })
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toMatchObject({ id: "01" })
    })

    it("asks while its agent is mid-turn, though it could be restored", () => {
      const app = asBackendSays({
        state: "running",
        agent: { working: true },
        restorable: true,
        busy: true,
      })
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toMatchObject({ id: "01" })
    })

    it("asks about a running agent that can't be restored, as one with no session yet", () => {
      const app = asBackendSays({ state: "running", agent: { working: false } })
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toMatchObject({ id: "01" })
    })

    it("closes an idle agent that can be restored without asking", () => {
      const app = asBackendSays({
        state: "running",
        process: "claude",
        agent: { working: false },
        restorable: true,
        busy: true,
      })
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toBeNull()
      expect(app.state().roster.terminals.map((item) => item.id)).not.toContain("01")
    })

    it("remembers which agent's switch Preferences should show, when a plug opens it", () => {
      const app = asBackendSays({ state: "idle" })
      app.commands.openAgentSettings("codex")
      expect(app.ui.getSnapshot().agentFocus).toBe("codex")
      expect(app.ui.getSnapshot().location.route.dialog).toBe("preferences")
    })

    it("does not take an agent that ran and left for one that runs", () => {
      const app = asBackendSays({ state: "idle", agentRan: true })
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toBeNull()
    })

    it("restores a row as a new terminal in the session on screen, selected, in its folder", () => {
      const app = openCommands({
        history,
        url: "/projects/project/sessions/initial/grid?terminal=01&panel=history",
      })
      const row = {
        id: "closed-7",
        projectId: "project",
        title: "Coupon codes",
        summary: null,
        handle: "wren",
        agent: "claude",
        program: "claude",
        cwd: "/work/storefront",
        closedAt: 1,
        closedBy: null,
        availability: { state: "ready" },
      } as const
      app.commands.restoreClosed(row)
      expect(app.allocated.at(-1)).toEqual({
        target: { projectId: "project", workspaceSessionId: "initial" },
        directory: "/work/storefront",
        closed: "closed-7",
      })
      // It leaves the title to the backend, and the sidebar on the panel it was on.
      expect(app.allocated.at(-1)).not.toHaveProperty("title")
      expect(app.state().selected).toBe(app.state().roster.terminals.at(-1)!.id)
      expect(app.state().selected).toMatch(/^new-/)
      expect(app.ui.getSnapshot().location.route.panel).toBe("history")
    })

    it("makes one terminal from a row clicked twice before the runner says it is restoring", () => {
      const row = {
        id: "closed-7",
        projectId: "project",
        title: "Coupon codes",
        summary: null,
        handle: "wren",
        agent: "claude",
        program: "claude",
        cwd: "/work/storefront",
        closedAt: 1,
        closedBy: null,
        availability: { state: "ready" },
      } as const
      const rows = createStore({ rows: [row] as readonly ClosedTerminal[] })
      const app = openCommands({ history: { state: rows, list: () => Promise.resolve([row]) } })
      app.commands.restoreClosed(row)
      app.commands.restoreClosed(row)
      expect(app.allocated).toHaveLength(1)
      // Once the runner says the row is restoring, and then it is gone, it is not held.
      rows.update(() => ({ rows: [{ ...row, availability: { state: "restoring" } }] }))
      rows.update(() => ({ rows: [row] }))
      app.commands.restoreClosed(row)
      expect(app.allocated).toHaveLength(2)
    })

    it("holds a second click on a row whose terminal failed no longer", () => {
      const row = {
        id: "closed-8",
        projectId: "project",
        title: "Tax rounding",
        summary: null,
        handle: null,
        agent: null,
        program: "zsh",
        cwd: "/work",
        closedAt: 1,
        closedBy: null,
        availability: { state: "ready" },
      } as const
      const rows = createStore({ rows: [row] as readonly ClosedTerminal[] })
      const app = openCommands({ history: { state: rows, list: () => Promise.resolve([row]) } })
      app.commands.restoreClosed(row)
      const made = app.state().selected
      app.workspace.dispatch({
        type: "terminal/status",
        target: { projectId: "project", workspaceSessionId: "initial" },
        terminalId: made,
        status: { state: "failed", message: "refused" },
      })
      app.commands.restoreClosed(row)
      expect(app.allocated).toHaveLength(2)
    })

    it("reveals a terminal by its id in the row's project, the session on screen first", () => {
      const workspace = twoSessions()
      const [initial, other] = workspace.projects[0]!.history
      // Handles are unique only per session: two sessions can both hold a @kite.
      initial!.state.roster.terminals[0]!.handle = "kite"
      other!.state.roster.terminals.at(-1)!.handle = "kite"
      const app = openCommands({ workspace, history })
      app.commands.revealTerminal(other!.state.roster.terminals.at(-1)!.id, "project")
      expect(app.ui.getSnapshot().location.route).toMatchObject({
        sessionId: "other",
        terminal: other!.state.roster.terminals.at(-1)!.id,
      })
      app.commands.revealTerminal(initial!.state.roster.terminals[0]!.id, "project")
      expect(app.ui.getSnapshot().location.route).toMatchObject({
        sessionId: "initial",
        terminal: initial!.state.roster.terminals[0]!.id,
      })
      // Another project's terminals are not this row's.
      app.commands.revealTerminal(other!.state.roster.terminals.at(-1)!.id, "elsewhere")
      expect(app.ui.getSnapshot().location.route.sessionId).toBe("initial")
      expect(() => app.commands.revealTerminal("nobody", "project")).not.toThrow()
    })
  })

  context("when the runner keeps crashing", () => {
    it("leaves it for this crash loop on Not now", () => {
      const app = openCommands()
      app.commands.dismissCrashLoop()
      expect(app.ui.getSnapshot().crashLoopDismissed).toBe(true)
    })

    it("asks the backend to start over on Try again, and would ask again next time", () => {
      let retries = 0
      const app = openCommands({ crashLoop: { crashes: createStore(4), retry: () => retries++ } })
      app.commands.dismissCrashLoop()
      app.commands.retryAfterCrashLoop()
      expect(retries).toBe(1)
      expect(app.ui.getSnapshot().crashLoopDismissed).toBe(false)
    })
  })

  context("when the update's notice and the sandbox's share their place", () => {
    it("closes the sandbox's on opening the update's, and the update's on opening the sandbox's", () => {
      const app = openCommands()
      app.commands.setSandboxOpen(true)
      app.commands.setPortableCardOpen(true)
      expect(app.ui.getSnapshot()).toMatchObject({ portableCardOpen: true, sandboxOpen: false })
      app.commands.setSandboxOpen(true)
      expect(app.ui.getSnapshot()).toMatchObject({ portableCardOpen: false, sandboxOpen: true })
    })

    it("leaves the other alone on closing one", () => {
      const app = openCommands()
      app.commands.setSandboxOpen(true)
      app.commands.setPortableCardOpen(false)
      expect(app.ui.getSnapshot().sandboxOpen).toBe(true)
    })
  })

  context("when closing a terminal", () => {
    it("brings the next selection into view only when the selected one closes outside Canvas", () => {
      const app = openCommands({ workspace: workspaceFixture({ terminals: 3 }) })
      const pulse = () => app.shell().navigation.count
      app.commands.close("03")
      expect(pulse()).toBe(1)
      app.commands.close("01")
      expect(pulse()).toBe(2)
      expect(app.state().selected).toBe("02")
      const canvas = openCommands({
        workspace: workspaceFixture({ view: "canvas" }),
        url: "/projects/project/sessions/initial/canvas?terminal=01",
      })
      canvas.commands.close("01")
      expect(canvas.shell().navigation.count).toBe(1)
    })

    it("drops a rename of that terminal without saving it", () => {
      const app = openCommands()
      app.commands.startRename(terminal(app, "02"), "sidebar")
      app.commands.changeRenameDraft("02", "Gone")
      app.commands.close("02")
      expect(app.ui.getSnapshot().rename).toBeNull()
      expect(app.state().roster.terminals.map((item) => item.name)).toEqual(["Terminal"])
    })
  })

  context("when toggling a sidebar panel in Zen", () => {
    it("leaves Zen and shows the panel, then hides it and focuses its toggle", () => {
      const app = openCommands()
      app.commands.hideSidebar()
      app.commands.enterZen()
      app.commands.toggleSidebar("sessions")
      expect(app.shell()).toMatchObject({ zen: null, sidebarCollapsed: false, sidebar: true })
      expect(app.ui.getSnapshot().location.route.panel).toBe("sessions")
      app.flush()
      expect(app.effects.at(-1)).toBe("focus sessions toggle")
      app.commands.toggleSidebar("sessions")
      expect(app.shell().sidebarCollapsed).toBe(true)
      expect(app.effects.at(-1)).toBe("focus sessions toggle")
    })
  })

  context("when pressing the open panel's toggle", () => {
    const panel = (app: ReturnType<typeof openCommands>) =>
      app.ui.getSnapshot().location.route.panel

    it("goes back one step, to the panel shown before it, then hides from there", () => {
      const app = openCommands()
      app.commands.hideSidebar()
      app.commands.toggleSidebar("terminals")
      app.commands.toggleSidebar("inbox")
      app.commands.toggleSidebar("sessions")
      // Sessions after the Inbox goes back to the Inbox, the panel just before it.
      app.commands.toggleSidebar("sessions")
      expect(panel(app)).toBe("inbox")
      expect(app.shell().sidebarCollapsed).toBe(false)
      // The step is spent: from the Inbox the same press hides, rather than going on.
      app.commands.toggleSidebar("inbox")
      expect(app.shell().sidebarCollapsed).toBe(true)
    })

    it("hides the sidebar where it has no step to go back, as on the panel it opened on", () => {
      const app = openCommands()
      app.commands.hideSidebar()
      app.commands.toggleSidebar("inbox")
      expect(app.shell().sidebarBack).toBeNull()
      app.commands.toggleSidebar("inbox")
      expect(app.shell().sidebarCollapsed).toBe(true)
    })

    it("has no step to go back on a panel the app moved to, as for a new session", () => {
      const app = openCommands()
      app.commands.toggleSidebar("inbox")
      app.commands.toggleSidebar("sessions")
      app.commands.startFresh()
      expect(panel(app)).toBe("terminals")
      app.commands.toggleSidebar("terminals")
      expect(app.shell().sidebarCollapsed).toBe(true)
    })

    it("goes back from a panel switched to on a sidebar left open", () => {
      const app = openCommands()
      expect(app.shell().sidebarBack).toBeNull()
      app.commands.toggleSidebar("sessions")
      app.commands.toggleSidebar("sessions")
      expect(panel(app)).toBe("terminals")
      app.commands.toggleSidebar("terminals")
      expect(app.shell().sidebarCollapsed).toBe(true)
    })
  })

  context("when the Inbox shows for one row, as a click on a toast shows it", () => {
    const panel = (app: ReturnType<typeof openCommands>) =>
      app.ui.getSnapshot().location.route.panel

    it("puts back the panel that showed, and typing in the selected terminal", () => {
      const app = openCommands()
      app.commands.showSessions()
      const back = app.commands.peekInbox()
      expect(panel(app)).toBe("inbox")
      // In place of the page the person was on, and back, so Back has no step for it.
      expect(app.ui.getSnapshot().location.navigationType).toBe("REPLACE")
      back!()
      expect(panel(app)).toBe("sessions")
      expect(app.ui.getSnapshot().location.navigationType).toBe("REPLACE")
      expect(app.shell()).toMatchObject({ sidebarCollapsed: false })
      app.flush()
      expect(app.effects.at(-1)).toBe(`focus input ${app.state().selected}`)
    })

    it("hides the sidebar again where it was hidden, and goes back to Zen", () => {
      const app = openCommands()
      app.commands.showSessions()
      app.commands.hideSidebar()
      app.commands.peekInbox()!()
      expect(app.shell()).toMatchObject({ sidebarCollapsed: true, zen: null })
      expect(panel(app)).toBe("sessions")
      app.commands.enterZen()
      const zen = app.shell().zen
      app.commands.peekInbox()!()
      expect(app.shell().zen).toEqual(zen)
    })

    it("goes back to the panel it showed over, and then has nothing to put back", () => {
      const app = openCommands()
      app.commands.showSessions()
      const back = app.commands.peekInbox()
      app.commands.toggleSidebar("inbox")
      expect(panel(app)).toBe("sessions")
      back!()
      expect(app.shell().sidebarCollapsed).toBe(false)
      expect(panel(app)).toBe("sessions")
    })

    it("puts back where the open panel's toggle went back to", () => {
      const app = openCommands()
      app.commands.toggleSidebar("sessions")
      app.commands.peekInbox()!()
      expect(panel(app)).toBe("sessions")
      app.commands.toggleSidebar("sessions")
      expect(panel(app)).toBe("terminals")
      expect(app.shell().sidebarCollapsed).toBe(false)
    })

    it("has nothing to put back where the Inbox showed already", () => {
      const app = openCommands()
      app.commands.showInbox()
      expect(app.commands.peekInbox()).toBeUndefined()
    })
  })

  context("when choosing from the recent switcher", () => {
    it("hands keyboard focus to the terminal only for a click-mode switcher", () => {
      const app = openCommands()
      app.commands.openSwitcher("01", { isConnected: true, focus: () => {} })
      app.commands.chooseRecent("02")
      expect(app.shell().keyboardFocus).toEqual({ id: "02", view: "grid" })
      expect(app.ui.getSnapshot().recent.switcher).toBeNull()
      expect(app.state().selected).toBe("02")
    })
  })

  context("when an agent asks for a terminal", () => {
    it("adds it beside the asking terminal as the + button would, without taking focus", () => {
      const app = openCommands({ url: "/projects/project/sessions/initial/canvas?terminal=01" })
      const urls = app.urls.length
      const { asked, answers } = asking()
      app.commands.openRequested(asked)
      // The backend names it: a title the agent asked for is the runner's to give.
      expect(app.allocated).toEqual([
        {
          target: { projectId: "project", workspaceSessionId: "initial" },
          directory: "/work/app",
          launch: { command: "claude" },
        },
      ])
      const added = terminal(app, "new-3")
      expect(added).toMatchObject({ directory: "/work/app" })
      expect(orderedTiles(app.state().roster).map((tile) => tile.id)).toContain("new-3")
      // The selection, the URL and any rename stay as they were.
      expect(app.state().selected).toBe("01")
      expect(app.urls).toHaveLength(urls)
      expect(app.ui.getSnapshot().rename).toBeNull()
      expect(answers).toEqual([{ terminalId: "new-3" }])
    })

    it("lists it under the asking terminal, not the selected one", () => {
      const app = openCommands({
        workspace: workspaceFixture(),
        url: "/projects/project/sessions/initial/canvas?terminal=02",
      })
      app.commands.openRequested(asking({ from: "01" }).asked)
      expect(orderedTiles(app.state().roster).map((tile) => tile.id)).toEqual(["01", "new-3", "02"])
    })

    it("lists it under the asking terminal, after the ones it opened before", () => {
      const workspace = workspaceFixture()
      const [first] = workspace.projects[0]!.history[0]!.state.roster.terminals
      first!.handle = "moth"
      const app = openCommands({ workspace })
      // Both before the backend says who opened either.
      app.commands.openRequested(asking({ from: "01" }).asked)
      app.commands.openRequested(asking({ from: "01" }).asked)
      expect(orderedTiles(app.state().roster).map((tile) => tile.id)).toEqual([
        "01",
        "new-3",
        "new-4",
        "02",
      ])
      expect(terminal(app, "new-3").openedBy).toBe("moth")
    })

    it("starts a plain shell when the agent gave no command", () => {
      const app = openCommands()
      const { command: _command, ...plain } = asking().asked
      app.commands.openRequested(plain)
      expect(app.allocated.at(-1)).toEqual({
        target: { projectId: "project", workspaceSessionId: "initial" },
        directory: "/work/app",
        launch: {},
      })
    })

    it("selects it and brings it into view only when the person asked to see it", () => {
      const app = openCommands()
      const { asked, answers } = asking({ focus: true })
      app.commands.openRequested(asked)
      expect(app.state().selected).toBe("new-3")
      expect(app.ui.getSnapshot().location.route.terminal).toBe("new-3")
      expect(app.ui.getSnapshot().created).toEqual({ context: "project/initial", id: "new-3" })
      expect(answers).toEqual([{ terminalId: "new-3" }])
    })

    it("adds it to the asking terminal's own session, coming to the front only when asked", () => {
      const app = openCommands({ workspace: twoSessions() })
      const quiet = asking({ from: "09" })
      app.commands.openRequested(quiet.asked)
      const other = () => app.workspace.getSnapshot().projects[0]!.history[1]!.state
      expect(other().roster.terminals.map((each) => each.id)).toContain("new-4")
      expect(app.state().roster.terminals.map((each) => each.id)).toEqual(["01", "02"])
      expect(app.ui.getSnapshot().location.route.sessionId).toBe("initial")
      expect(quiet.answers).toEqual([{ terminalId: "new-4" }])
      const shown = asking({ from: "09", focus: true })
      app.commands.openRequested(shown.asked)
      expect(app.ui.getSnapshot().location.route).toMatchObject({
        sessionId: "other",
        terminal: "new-5",
      })
      expect(app.state().selected).toBe("new-5")
    })

    it("answers why not when the asking terminal is in no session", () => {
      const app = openCommands()
      const { asked, answers } = asking({ from: "gone" })
      app.commands.openRequested(asked)
      expect(app.allocated).toEqual([])
      expect(app.state().roster.terminals).toHaveLength(2)
      expect(answers).toEqual([{ reason: "The terminal that asked isn't open in Novadeck." }])
    })
  })

  context("when the person clicks an Inbox row or desktop notification about a terminal", () => {
    it("selects it in the session on screen", () => {
      const app = openCommands({ url: "/projects/project/sessions/initial/grid?terminal=01" })
      app.commands.reveal("02")
      expect(app.state().selected).toBe("02")
      expect(app.ui.getSnapshot().location.route.terminal).toBe("02")
    })

    it("closes a dialog open over it", () => {
      const app = openCommands({
        url: "/projects/project/sessions/initial/grid?terminal=01&dialog=preferences",
      })
      app.commands.reveal("02")
      expect(app.ui.getSnapshot().location.route).toMatchObject({ terminal: "02", dialog: null })
      expect(app.state().selected).toBe("02")
    })

    it("brings its session to the front and selects it there", () => {
      const app = openCommands({ workspace: twoSessions() })
      app.commands.reveal("09")
      expect(app.ui.getSnapshot().location.route).toMatchObject({
        sessionId: "other",
        terminal: "09",
      })
      expect(app.state().selected).toBe("09")
    })

    it("asks the view to fly in to it, as Canvas does from a header", () => {
      const app = openCommands()
      const { count } = app.shell().navigation
      app.commands.reveal("02")
      expect(app.shell().navigation).toEqual({ count: count + 1, move: "fly" })
    })

    it("opens what an agent asked to show on it, which waited", () => {
      const app = openCommands()
      const page = itemFixture("page", "02", { openAsked: true })
      app.workspace.dispatch({
        type: "item/upsert",
        target: { projectId: "project", workspaceSessionId: "initial" },
        item: page,
      })
      expect(app.state().waiting).toEqual([page.id])
      app.commands.reveal("02")
      expect(app.state().waiting).toEqual([])
      expect(app.state().bars["02"]).toMatchObject({ stack: [page.id], open: true })
    })

    it("does nothing for a terminal that is gone", () => {
      const app = openCommands()
      const urls = app.urls.length
      app.commands.reveal("gone")
      expect(app.urls).toHaveLength(urls)
    })
  })

  context("when disabling the view on screen", () => {
    it("moves to an enabled view and closes the reveal and drawer", () => {
      const app = openCommands()
      app.ui.update((state) => ({ ...state, shell: { ...state.shell, revealCanvas: true } }))
      app.commands.updatePreferences({
        fontSize: 13,
        enabledViews: ["focus", "canvas"],
        appearance,
        notifyNeeds: true,
        notifyFinished: true,
        sound: true,
        soundVolume: 0.6,
        soundChoice: "theme",
        ligatures: false,
        chatView: false,
      })
      expect(app.state().view).not.toBe("grid")
      expect(app.shell().revealCanvas).toBe(false)
      expect(app.effects).toContain("cancel transition")
    })
  })
})
