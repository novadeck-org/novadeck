import { createWorkspaceStore } from "../model/store"
import type { AgentStatus } from "../model/types"
import { context, describe, expect, it } from "../test"
import { appearance, workspaceFixture } from "../test/fixtures"
import {
  createUiStore,
  initialUi,
  persist,
  trackRecent,
  watchFinishes,
  watchPresentation,
  watchSwitcher,
  type FinishNotify,
  type UiState,
} from "./ui-store"

const initial = (): UiState =>
  initialUi({
    location: {
      route: {
        projectId: "project",
        sessionId: "initial",
        view: "focus",
        terminal: "",
        panel: "terminals",
        dialog: null,
        section: "general",
      },
      dialogDepth: 0,
      navigationType: "POP",
    },
    preferences: {
      fontSize: 13,
      enabledViews: ["focus", "grid"],
      appearance,
      notifyFinished: true,
      ligatures: false,
    },
  })

describe("UI store persistence", () => {
  context("when attached", () => {
    it("writes the slice at once and again only after it changes", () => {
      const ui = createUiStore(initial())
      const written: number[] = []
      const stop = persist(
        ui,
        (state) => state.preferences,
        (preferences) => written.push(preferences.fontSize),
      )
      expect(written).toEqual([13])
      ui.update((state) => ({ ...state }))
      expect(written).toEqual([13])
      ui.update((state) => ({ ...state, preferences: { ...state.preferences, fontSize: 15 } }))
      expect(written).toEqual([13, 15])
      stop()
      ui.update((state) => ({ ...state, preferences: { ...state.preferences, fontSize: 12 } }))
      expect(written).toEqual([13, 15])
    })
  })
})

const session = (id: string) => ({
  ...workspaceFixture().projects[0]!.history[0]!,
  id,
  name: id,
})

describe("presentation watch", () => {
  context("when a commit changes the session", () => {
    it("starts the presentation over and opens the drawer for the session just created", () => {
      const workspace = createWorkspaceStore(workspaceFixture({ sessions: ["initial", "other"] }))
      const ui = createUiStore(initial())
      const stop = watchPresentation(workspace, ui)
      ui.update((state) => ({
        ...state,
        shell: { ...state.shell, freshSession: "fresh", revealCanvas: true },
      }))
      workspace.dispatch({ type: "session/add", projectId: "project", session: session("fresh") })
      expect(ui.getSnapshot().shell).toMatchObject({
        navigation: { count: 2, fit: false },
        revealCanvas: false,
        sidebar: true,
        freshSession: null,
      })
      workspace.dispatch({
        type: "session/select",
        projectId: "project",
        workspaceSessionId: "other",
        now: 1,
      })
      expect(ui.getSnapshot().shell).toMatchObject({ navigation: { count: 3 }, sidebar: false })
      stop()
    })
  })

  context("when a commit keeps the session", () => {
    it("leaves the presentation alone", () => {
      const workspace = createWorkspaceStore(workspaceFixture())
      const ui = createUiStore(initial())
      const stop = watchPresentation(workspace, ui)
      const before = ui.getSnapshot()
      workspace.dispatch({
        type: "terminal/select",
        target: { projectId: "project", workspaceSessionId: "initial" },
        terminalId: "02",
      })
      expect(ui.getSnapshot()).toBe(before)
      stop()
    })
  })
})

describe("recent terminal tracking", () => {
  it("records the active session's most recent order after each commit", () => {
    const workspace = createWorkspaceStore(workspaceFixture({ terminals: 3 }))
    const ui = createUiStore(initial())
    const stop = trackRecent(workspace, ui)
    const recent = () => ui.getSnapshot().recent.byContext["project/initial"]
    expect(recent()).toEqual(["01", "02", "03"])
    workspace.dispatch({
      type: "terminal/select",
      target: { projectId: "project", workspaceSessionId: "initial" },
      terminalId: "03",
    })
    expect(recent()).toEqual(["03", "01", "02"])
    const before = ui.getSnapshot()
    workspace.dispatch({
      type: "terminal/rename",
      target: { projectId: "project", workspaceSessionId: "initial" },
      terminalId: "01",
      name: "Server",
    })
    expect(ui.getSnapshot()).toBe(before)
    stop()
  })
})

describe("switcher watch", () => {
  it("closes the switcher when a dialog opens or the session changes", () => {
    const workspace = createWorkspaceStore(workspaceFixture({ sessions: ["initial", "other"] }))
    const ui = createUiStore(initial())
    const stop = watchSwitcher(workspace, ui)
    const open = () =>
      ui.update((state) => ({
        ...state,
        recent: {
          ...state.recent,
          switcher: {
            context: "project/initial",
            ids: ["01", "02"],
            index: 1,
            fromInput: false,
            mode: "click",
          },
        },
      }))
    open()
    expect(ui.getSnapshot().recent.switcher).not.toBeNull()
    ui.update((state) => ({
      ...state,
      location: { ...state.location, route: { ...state.location.route, dialog: "search" } },
    }))
    expect(ui.getSnapshot().recent.switcher).toBeNull()
    ui.update((state) => ({
      ...state,
      location: { ...state.location, route: { ...state.location.route, dialog: null } },
    }))
    open()
    workspace.dispatch({
      type: "session/select",
      projectId: "project",
      workspaceSessionId: "other",
      now: 1,
    })
    expect(ui.getSnapshot().recent.switcher).toBeNull()
    stop()
  })
})

describe("finish watch", () => {
  const target = { projectId: "project", workspaceSessionId: "initial" }
  // A workspace whose terminal 02 runs a working agent, terminal 01 selected.
  const setup = (notifyFinished = true) => {
    const workspace = createWorkspaceStore(workspaceFixture())
    const ui = createUiStore({
      ...initial(),
      preferences: { ...initial().preferences, notifyFinished },
    })
    const notices: Parameters<FinishNotify>[0][] = []
    const status = (terminalId: string, agent: AgentStatus) =>
      workspace.dispatch({
        type: "terminal/status",
        target,
        terminalId,
        status: { state: "running", agent },
      })
    const select = (terminalId: string) =>
      workspace.dispatch({ type: "terminal/select", target, terminalId })
    workspace.dispatch({
      type: "terminal/update",
      target,
      terminalId: "02",
      name: "Checkout",
      handle: "t2",
    })
    select("01")
    status("02", { working: true })
    const stop = watchFinishes(workspace, ui, (notice) => notices.push(notice))
    const unread = () => ui.getSnapshot().unread
    const finish = (at = 10, outcome: "completed" | "failed" = "completed") =>
      status("02", { working: false, lastTurn: { outcome, reply: "All green.", at } })
    return { workspace, ui, notices, status, select, unread, finish, stop }
  }

  context("when an agent finishes in a terminal the person isn't looking at", () => {
    it("marks it unread and shows one notification with the start of its reply", () => {
      const { notices, unread, finish, stop } = setup()
      finish()
      expect(unread()).toEqual({ "project/initial": { "02": "done" } })
      expect(notices).toEqual([{ id: "02", title: "t2 is done: Checkout", body: "All green." }])
      stop()
    })

    it("clears the mark once the person selects it", () => {
      const { unread, finish, select, stop } = setup()
      finish()
      select("02")
      expect(unread()).toEqual({})
      stop()
    })

    it("clears the mark once the agent starts another turn", () => {
      const { unread, finish, status, stop } = setup()
      finish()
      status("02", { working: true })
      expect(unread()).toEqual({})
      stop()
    })

    it("marks it without a notification when the person turned them off", () => {
      const { notices, unread, finish, stop } = setup(false)
      finish()
      expect(unread()).toEqual({ "project/initial": { "02": "done" } })
      expect(notices).toEqual([])
      stop()
    })
  })

  context("when the statuses that tell a finish come together", () => {
    it("finishes once for each end it hasn't seen, whether or not it saw the agent work", () => {
      const { notices, unread, finish, stop } = setup()
      finish(10)
      finish(10)
      // The next turn's start and end came as one status.
      finish(20)
      expect(notices).toHaveLength(2)
      expect(unread()).toEqual({ "project/initial": { "02": "done" } })
      stop()
    })
  })

  context("when the turn ended on an error", () => {
    it("marks it failed and says it stopped with an error", () => {
      const { notices, unread, finish, stop } = setup()
      finish(10, "failed")
      expect(unread()).toEqual({ "project/initial": { "02": "failed" } })
      expect(notices).toEqual([
        { id: "02", title: "t2 stopped with an error: Checkout", body: "All green." },
      ])
      stop()
    })
  })

  it("takes an end already shown when it starts as seen, as after a reload", () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    workspace.dispatch({
      type: "terminal/status",
      target,
      terminalId: "02",
      status: {
        state: "running",
        agent: { working: false, lastTurn: { outcome: "completed", at: 5 } },
      },
    })
    const ui = createUiStore(initial())
    const notices: unknown[] = []
    const stop = watchFinishes(workspace, ui, (notice) => notices.push(notice))
    workspace.dispatch({ type: "terminal/select", target, terminalId: "01" })
    expect(notices).toEqual([])
    expect(ui.getSnapshot().unread).toEqual({})
    stop()
  })

  context("when the person looks at the terminal as its agent finishes", () => {
    it("neither marks nor notifies", () => {
      const { notices, unread, finish, select, stop } = setup()
      select("02")
      finish()
      expect(unread()).toEqual({})
      expect(notices).toEqual([])
      stop()
    })

    it("marks and notifies while the page has no focus, and clears once it has", () => {
      const { ui, notices, unread, finish, select, stop } = setup()
      select("02")
      ui.update((state) => ({ ...state, pageFocused: false }))
      finish()
      expect(unread()).toEqual({ "project/initial": { "02": "done" } })
      expect(notices).toHaveLength(1)
      ui.update((state) => ({ ...state, pageFocused: true }))
      expect(unread()).toEqual({})
      stop()
    })
  })

  it("forgets the mark of a terminal that closed", () => {
    const { workspace, unread, finish, stop } = setup()
    finish()
    workspace.dispatch({ type: "terminal/close", target, terminalId: "02" })
    expect(unread()).toEqual({})
    stop()
  })
})
