import { afterEach, beforeEach, vi } from "vitest"

import type { PortableState } from "#core/portable"
import { clearPortableCardRaised } from "#core/portable-card-raised"
import { createWorkspaceStore } from "#core/store"
import type { AgentStatus } from "#core/types"
import type { UpdateOffer } from "#core/update"

import { context, describe, expect, it } from "../test"
import { appearance, workspaceFixture } from "../test/fixtures"
import {
  createUiStore,
  initialUi,
  notePortableCardShown,
  persist,
  trackRecent,
  watchFinishes,
  watchPortable,
  watchPresentation,
  watchSandbox,
  watchSwitcher,
  watchUpdates,
  type FinishNotify,
  type UiState,
} from "./ui-store"

// A run of the app's memory of what it raised outlasts a store, so each test starts one.
beforeEach(() => clearPortableCardRaised())

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
      chatView: false,
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
  const setup = (notifyFinished = true, graceMs = 0) => {
    const workspace = createWorkspaceStore(workspaceFixture())
    const ui = createUiStore({
      ...initial(),
      preferences: { ...initial().preferences, notifyFinished },
    })
    const notices: Parameters<FinishNotify>[0][] = []
    const gists: [string, number][] = []
    const completed: string[] = []
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
      handle: "fox",
    })
    select("01")
    status("02", { working: true })
    const stop = watchFinishes(workspace, ui, {
      notify: (notice) => notices.push(notice),
      graceMs,
      unread: (terminalId, at) => gists.push([terminalId, at]),
      finished: (where, id) => completed.push(`${where}/${id}`),
    })
    const unread = () => ui.getSnapshot().unread
    const finish = (at = 10, outcome: "completed" | "failed" | "interrupted" = "completed") =>
      status("02", { working: false, lastTurn: { outcome, reply: "All green.", at } })
    return { workspace, ui, notices, gists, completed, status, select, unread, finish, stop }
  }

  context("when an agent's turn ends complete", () => {
    it("tells the finish hook the terminal and its session, whoever looks at it", () => {
      const { completed, finish, select, stop } = setup()
      select("02")
      finish()
      expect(completed).toEqual(["project/initial/02"])
      stop()
    })

    it("tells it once the end still stands after the grace, and not when the person's Escape turned it interrupted", () => {
      vi.useFakeTimers()
      try {
        const { completed, finish, stop } = setup(true, 100)
        finish(10)
        expect(completed).toEqual([])
        finish(10, "interrupted")
        vi.advanceTimersByTime(150)
        expect(completed).toEqual([])
        finish(11)
        vi.advanceTimersByTime(150)
        expect(completed).toEqual(["project/initial/02"])
        stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it("tells it nothing of a turn that failed, or of an end shown when it started", () => {
      const { completed, finish, stop } = setup()
      finish(10, "failed")
      expect(completed).toEqual([])
      stop()
    })
  })

  context("when an agent finishes in a terminal the person isn't looking at", () => {
    it("marks it unread and shows one notification with the start of its reply", () => {
      const { notices, unread, finish, stop } = setup()
      finish()
      expect(unread()).toEqual({ "project/initial": { "02": "done" } })
      expect(notices).toEqual([{ id: "02", title: "@fox is done: Checkout", body: "All green." }])
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

  context("when its harness may yet say the person's Escape stopped the turn", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it("waits out the grace before it marks the end unread and notifies", () => {
      const { notices, unread, finish, stop } = setup(true, 700)
      finish()
      vi.advanceTimersByTime(699)
      expect(unread()).toEqual({})
      expect(notices).toEqual([])
      vi.advanceTimersByTime(1)
      expect(unread()).toEqual({ "project/initial": { "02": "done" } })
      expect(notices).toHaveLength(1)
      stop()
    })

    it("neither marks nor notifies when the same turn's end turns interrupted meanwhile", () => {
      const { notices, unread, finish, stop } = setup(true, 700)
      finish(10)
      vi.advanceTimersByTime(300)
      finish(20, "interrupted")
      vi.advanceTimersByTime(1000)
      expect(unread()).toEqual({})
      expect(notices).toEqual([])
      stop()
    })

    it("neither marks nor notifies when the agent works again meanwhile", () => {
      const { notices, unread, finish, status, stop } = setup(true, 700)
      finish(10)
      status("02", { working: true })
      vi.advanceTimersByTime(1000)
      expect(unread()).toEqual({})
      expect(notices).toEqual([])
      stop()
    })

    it("marks a failed end at once", () => {
      const { unread, finish, stop } = setup(true, 700)
      finish(10, "failed")
      expect(unread()).toEqual({ "project/initial": { "02": "failed" } })
      stop()
    })

    it("drops what waits when it stops", () => {
      const { notices, finish, stop } = setup(true, 700)
      finish()
      stop()
      vi.advanceTimersByTime(1000)
      expect(notices).toEqual([])
    })
  })

  context("when the turn ended on an error", () => {
    it("marks it failed and says it stopped with an error", () => {
      const { notices, unread, finish, stop } = setup()
      finish(10, "failed")
      expect(unread()).toEqual({ "project/initial": { "02": "failed" } })
      expect(notices).toEqual([
        { id: "02", title: "@fox stopped with an error: Checkout", body: "All green." },
      ])
      stop()
    })
  })

  context("when a finish is unread", () => {
    it("tells murmur once, with the end's time", () => {
      const { gists, finish, stop } = setup()
      finish(10)
      expect(gists).toEqual([["02", 10]])
      stop()
    })

    it("tells it also when the person turned notifications off", () => {
      const { gists, notices, finish, stop } = setup(false)
      finish(10)
      expect(notices).toEqual([])
      expect(gists).toEqual([["02", 10]])
      stop()
    })

    it("tells it each end that goes unseen", () => {
      const { gists, status, finish, stop } = setup()
      finish(10)
      status("02", { working: true })
      finish(20)
      expect(gists).toEqual([
        ["02", 10],
        ["02", 20],
      ])
      stop()
    })

    it("does not, for a terminal the person looks at", () => {
      const { gists, finish, select, stop } = setup()
      select("02")
      finish()
      expect(gists).toEqual([])
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
    const stop = watchFinishes(workspace, ui, { notify: (notice) => notices.push(notice) })
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

const updateHost = () => {
  let report: ((offer: UpdateOffer) => void) | undefined
  const updates = {
    onOffer: (listener: (offer: UpdateOffer) => void) => {
      report = listener
      return () => {
        report = undefined
      }
    },
    openPage: () => {},
  }
  return {
    updates,
    report: (offer: UpdateOffer) => report?.(offer),
    listening: () => !!report,
  }
}

const offered = (
  version: string,
  kind: "ready" | "retrying" | "available" = "ready",
): UpdateOffer => ({
  kind,
  version,
})

describe("a waiting update", () => {
  it("is kept as the offer the backend reports, a newer one replacing it", () => {
    const { updates, report, listening } = updateHost()
    const ui = createUiStore(initial())
    const stop = watchUpdates(updates, ui)
    expect(ui.getSnapshot().update).toBeNull()
    report(offered("0.0.80"))
    expect(ui.getSnapshot().update).toEqual(offered("0.0.80"))
    report(offered("0.0.81", "available"))
    expect(ui.getSnapshot().update).toEqual(offered("0.0.81", "available"))
    stop()
    expect(listening()).toBe(false)
  })

  it("raises no notice on a copy that updates itself, whatever it is offered", async () => {
    const { updates, report } = updateHost()
    const ui = createUiStore(initial())
    watchUpdates(updates, ui)
    expect(ui.getSnapshot().portable).toBeNull()
    report(offered("0.0.80"))
    report(offered("0.0.81", "available"))
    report({ kind: "downloading", version: "0.0.82", percent: 10 })
    expect(ui.getSnapshot().portableCardOpen).toBe(false)
    ui.update((state) => ({ ...state, portable: { portable: false } }))
    report(offered("0.0.83"))
    expect(ui.getSnapshot().portableCardOpen).toBe(false)
  })

  it("is never there where the backend has no updates", () => {
    const ui = createUiStore(initial())
    watchUpdates(undefined, ui)()
    expect(ui.getSnapshot().update).toBeNull()
  })
})

describe("the sandbox", () => {
  it("is kept as the backend says it, once", async () => {
    const ui = createUiStore(initial())
    let asked = 0
    watchSandbox(() => {
      asked += 1
      return Promise.resolve({ sandboxed: false, fix: "sudo fix" })
    }, ui)
    expect(ui.getSnapshot().sandbox).toBeNull()
    await vi.waitFor(() =>
      expect(ui.getSnapshot().sandbox).toEqual({ sandboxed: false, fix: "sudo fix" }),
    )
    expect(asked).toBe(1)
  })

  it("is never there where the backend does not say, or fails to", async () => {
    const ui = createUiStore(initial())
    watchSandbox(undefined, ui)()
    watchSandbox(() => Promise.reject(new Error("no")), ui)
    await Promise.resolve()
    expect(ui.getSnapshot().sandbox).toBeNull()
  })

  it("is not kept once the watch is stopped", async () => {
    const ui = createUiStore(initial())
    watchSandbox(() => Promise.resolve({ sandboxed: true }), ui)()
    await Promise.resolve()
    expect(ui.getSnapshot().sandbox).toBeNull()
  })
})

describe("a portable copy", () => {
  const here = {
    portable: true,
    version: "0.0.70",
    run: "run-1",
    install: { phase: "idle" },
  } as const satisfies PortableState
  const done = { ...here, install: { phase: "installed" } } as const satisfies PortableState
  const host = (state: PortableState = here) => ({
    state: () => Promise.resolve(state),
    onState: () => () => {},
    install: () => {},
  })
  const available = offered("0.0.80", "available")

  it("is kept as the backend says it, once", async () => {
    const ui = createUiStore(initial())
    let asked = 0
    watchPortable(
      {
        ...host(),
        state: () => {
          asked += 1
          return Promise.resolve(here)
        },
      },
      ui,
    )
    expect(ui.getSnapshot().portable).toBeNull()
    await vi.waitFor(() => expect(ui.getSnapshot().portable).toEqual(here))
    expect(asked).toBe(1)
  })

  it("is never there where the backend does not say, or fails to", async () => {
    const ui = createUiStore(initial())
    watchPortable(undefined, ui)()
    expect(ui.getSnapshot().portable).toBeNull()
    watchPortable({ ...host(), state: () => Promise.reject(new Error("no")) }, ui)
    await vi.waitFor(() => expect(ui.getSnapshot().portable).toEqual({ portable: false }))
  })

  it("raises its card once the host says it is portable, with no release known", async () => {
    const ui = createUiStore(initial())
    watchPortable(host(), ui)
    await vi.waitFor(() => expect(ui.getSnapshot().portableCardOpen).toBe(true))
  })

  it("raises its card for a release, whichever is heard first", async () => {
    // The offer first: nothing opens until the host says this is a portable copy.
    const first = updateHost()
    const early = createUiStore(initial())
    watchUpdates(first.updates, early)
    first.report(available)
    expect(early.getSnapshot().portableCardOpen).toBe(false)
    watchPortable(host(), early)
    await vi.waitFor(() => expect(early.getSnapshot().portableCardOpen).toBe(true))
    // The answer first, in another run.
    clearPortableCardRaised()
    const second = updateHost()
    const late = createUiStore(initial())
    watchPortable(host(), late)
    await vi.waitFor(() => expect(late.getSnapshot().portable).toEqual(here))
    late.update((state) => ({ ...state, portableCardOpen: false }))
    watchUpdates(second.updates, late)
    second.report(available)
    expect(late.getSnapshot().portableCardOpen).toBe(true)
  })

  it("raises nothing when this run installed the app already", async () => {
    const ui = createUiStore(initial())
    watchPortable(host(done), ui)
    await vi.waitFor(() => expect(ui.getSnapshot().portable).toEqual(done))
    expect(ui.getSnapshot().portableCardOpen).toBe(false)
  })

  it("takes a state the host pushes, which wins over an answer that comes after it", async () => {
    const ui = createUiStore(initial())
    let push: (state: PortableState) => void = () => {}
    let answer: (state: PortableState) => void = () => {}
    watchPortable(
      {
        ...host(),
        state: () => new Promise((resolve) => (answer = resolve)),
        onState: (listener) => {
          push = listener
          return () => {}
        },
      },
      ui,
    )
    push(done)
    answer(here)
    await Promise.resolve()
    expect(ui.getSnapshot().portable).toEqual(done)
    expect(ui.getSnapshot().portableCardOpen).toBe(false)
  })

  it("raises nothing when the answer is that it is not a portable copy", async () => {
    const { updates, report } = updateHost()
    const ui = createUiStore(initial())
    watchUpdates(updates, ui)
    report(available)
    watchPortable(host({ portable: false }), ui)
    await vi.waitFor(() => expect(ui.getSnapshot().portable).toEqual({ portable: false }))
    expect(ui.getSnapshot().portableCardOpen).toBe(false)
  })

  it("does not raise its card again for a later offer once it was shown this run", async () => {
    const { updates, report } = updateHost()
    const ui = createUiStore(initial())
    watchPortable(host(), ui)
    watchUpdates(updates, ui)
    await vi.waitFor(() => expect(ui.getSnapshot().portableCardOpen).toBe(true))
    // Shown, then dismissed.
    notePortableCardShown(here)
    ui.update((state) => ({ ...state, portableCardOpen: false }))
    report(available)
    report(offered("0.0.81", "available"))
    expect(ui.getSnapshot().portableCardOpen).toBe(false)
  })

  context(
    "in a store made anew within the run, as a page reload or a window opened again does",
    () => {
      // A store as a launch makes one, once the host has said.
      const launch = async (run: string = here.run): Promise<boolean> => {
        const ui = createUiStore(initial())
        watchPortable(host({ ...here, run }), ui)
        await vi.waitFor(() => expect(ui.getSnapshot().portable).toEqual({ ...here, run }))
        return ui.getSnapshot().portableCardOpen
      }

      it("raises the card again when it was raised but never shown", async () => {
        expect(await launch()).toBe(true)
        expect(await launch()).toBe(true)
      })

      it("does not raise it again once shown, until a relaunch", async () => {
        expect(await launch()).toBe(true)
        // The footer shows the card, as the command `portableCardShown` records.
        notePortableCardShown(here)
        // The window closed and opened again: the page is new and the run the same.
        sessionStorage.clear()
        expect(await launch()).toBe(false)
        expect(await launch("run-2")).toBe(true)
      })
    },
  )
})
