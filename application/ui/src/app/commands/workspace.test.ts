import { afterEach, vi } from "vitest"

import { createStore } from "../../model/store"
import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import { workspaceFixture } from "../../test/fixtures"
import { keyState } from "./keys"

const terminal = (app: ReturnType<typeof openCommands>, id: string) =>
  app.state().roster.terminals.find((item) => item.id === id)!

afterEach(() => void vi.useRealTimers())

// A workspace whose first terminal runs a program.
const running = () => {
  const workspace = workspaceFixture()
  const state = workspace.projects[0]!.history[0]!.state
  state.roster.terminals[0] = {
    ...state.roster.terminals[0]!,
    state: "running",
    process: "vim",
  }
  return workspace
}

describe("workspace commands", () => {
  context("when adding a terminal while another is being renamed", () => {
    it("saves the rename in progress and starts renaming the new terminal", () => {
      const app = openCommands()
      app.commands.startRename(terminal(app, "01"), "sidebar")
      app.commands.changeRenameDraft("01", "Server")
      const id = app.commands.add()
      expect(terminal(app, "01").name).toBe("Server")
      expect(app.ui.getSnapshot().rename).toMatchObject({ id, origin: "sidebar" })
      expect(app.state().selected).toBe(id)
    })
  })

  context("when adding a terminal from the keyboard", () => {
    it("opens the collapsed sidebar and renames the terminal there", () => {
      const app = openCommands()
      app.commands.hideSidebar()
      app.commands.add({ fromKeyboard: true })
      expect(app.shell().sidebarCollapsed).toBe(false)
      expect(app.ui.getSnapshot().rename?.origin).toBe("sidebar")
      expect(app.ui.getSnapshot().location.route.panel).toBe("terminals")
    })

    it("renames in the header in Zen or on a phone", () => {
      const zen = openCommands()
      zen.commands.enterZen()
      zen.commands.add({ fromKeyboard: true })
      expect(zen.ui.getSnapshot().rename?.origin).toBe("header")
      const phone = openCommands({ desktop: false })
      phone.commands.add({ fromKeyboard: true })
      expect(phone.ui.getSnapshot().rename?.origin).toBe("header")
    })
  })

  context("when adding a terminal from a view background", () => {
    it("saves a rename in progress and does not start another", () => {
      const app = openCommands()
      app.commands.startRename(terminal(app, "02"), "header")
      app.commands.changeRenameDraft("02", "Logs")
      app.commands.add({ beginRename: false })
      expect(terminal(app, "02").name).toBe("Logs")
      expect(app.ui.getSnapshot().rename).toBeNull()
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
    it("numbers the second one and shows the Sessions panel", () => {
      const app = openCommands()
      app.commands.startFresh()
      app.commands.startFresh()
      const [second, first] = app.workspace.getSnapshot().projects[0]!.history
      expect(second!.name).toBe(`${first!.name} (2)`)
      expect(app.ui.getSnapshot().location.route).toMatchObject({
        sessionId: second!.id,
        panel: "sessions",
      })
      // The phone drawer opens on the session just created.
      expect(app.shell()).toMatchObject({
        freshSession: null,
        sidebar: true,
        sidebarCollapsed: false,
      })
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

    it("closes an idle terminal without asking", () => {
      const app = openCommands()
      app.commands.close("01")
      expect(app.ui.getSnapshot().closing).toBeNull()
      expect(app.state().roster.terminals.map((item) => item.id)).not.toContain("01")
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
      expect(app.state().roster.terminals.map((item) => item.name)).toEqual(["Terminal 01"])
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
      app.commands.toggleSidebar("sessions")
      expect(app.shell().sidebarCollapsed).toBe(true)
      expect(app.effects.at(-1)).toBe("focus sessions toggle")
    })
  })

  context("when a view saves its layout after the session changed", () => {
    it("saves it to the session the view showed", () => {
      const app = openCommands({ workspace: workspaceFixture({ sessions: ["initial", "other"] }) })
      const shown = { projectId: "project", workspaceSessionId: "initial" }
      app.commands.switchSession("other")
      app.commands.setGridLayouts(shown, { desktop: [{ i: "01", x: 3, y: 0, w: 3, h: 4 }] })
      const [initial, other] = app.workspace.getSnapshot().projects[0]!.history
      expect(initial!.state.layout.grid.desktop).toEqual([{ i: "01", x: 3, y: 0, w: 3, h: 4 }])
      expect(other!.state.layout.grid).toEqual({})
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

  context("when disabling the view on screen", () => {
    it("moves to an enabled view and closes the reveal and drawer", () => {
      const app = openCommands()
      app.ui.update((state) => ({ ...state, shell: { ...state.shell, revealCanvas: true } }))
      app.commands.updatePreferences({ fontSize: 13, enabledViews: ["focus", "canvas"] })
      expect(app.state().view).not.toBe("grid")
      expect(app.shell().revealCanvas).toBe(false)
      expect(app.effects).toContain("cancel transition")
    })
  })
})
