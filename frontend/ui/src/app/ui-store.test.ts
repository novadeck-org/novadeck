import type { PortableState } from "@novadeck/core/portable"
import { clearPortableCardRaised } from "@novadeck/core/portable-card-raised"
import { createWorkspaceStore } from "@novadeck/core/store"
import { appearance, workspaceFixture } from "@novadeck/core/testing"
import type { UpdateChannel, UpdateOffer, WhatsNew } from "@novadeck/core/update"
import { beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import {
  chatViewOn,
  createUiStore,
  dismissWhatsNew,
  initialUi,
  notePortableCardShown,
  persist,
  setFeatureFlag,
  trackRecent,
  watchExperimental,
  watchPortable,
  watchPresentation,
  watchSandbox,
  watchSwitcher,
  watchUpdates,
  watchWhatsNew,
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
      notifyNeeds: true,
      notifyFinished: true,
      sound: true,
      soundVolume: 0.6,
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
        navigation: { count: 2, move: "center" },
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

const notes: WhatsNew = {
  version: "0.2.0",
  highlights: [{ title: "Word handles", line: "Talk to @moth." }],
}

const whatsNewHost = (answer: Promise<WhatsNew | undefined>) => {
  const calls = { dismissed: 0, pages: 0 }
  return {
    calls,
    whatsNew: {
      get: () => answer,
      dismiss: () => void (calls.dismissed += 1),
      openPage: () => void (calls.pages += 1),
    },
  }
}

describe("what's new", () => {
  it("is asked once and kept for the footer's card", async () => {
    const { whatsNew } = whatsNewHost(Promise.resolve(notes))
    const ui = createUiStore(initial())
    watchWhatsNew(whatsNew, ui)
    expect(ui.getSnapshot().whatsNew).toBeNull()
    await vi.waitFor(() => expect(ui.getSnapshot().whatsNew).toEqual(notes))
  })

  it("stays empty when the host has nothing, fails, or is not there", async () => {
    const none = createUiStore(initial())
    watchWhatsNew(whatsNewHost(Promise.resolve(undefined)).whatsNew, none)
    const failing = createUiStore(initial())
    watchWhatsNew(whatsNewHost(Promise.reject(new Error("no"))).whatsNew, failing)
    watchWhatsNew(undefined, createUiStore(initial()))()
    await Promise.resolve()
    await Promise.resolve()
    expect(none.getSnapshot().whatsNew).toBeNull()
    expect(failing.getSnapshot().whatsNew).toBeNull()
  })

  it("ignores an answer that comes after the page stopped asking", async () => {
    const ui = createUiStore(initial())
    watchWhatsNew(whatsNewHost(Promise.resolve(notes)).whatsNew, ui)()
    await Promise.resolve()
    await Promise.resolve()
    expect(ui.getSnapshot().whatsNew).toBeNull()
  })

  it("is dismissed to the host once, and the card goes", () => {
    const { whatsNew, calls } = whatsNewHost(Promise.resolve(notes))
    const ui = createUiStore({ ...initial(), whatsNew: notes })
    dismissWhatsNew(whatsNew, ui)
    expect(ui.getSnapshot().whatsNew).toBeNull()
    expect(calls).toEqual({ dismissed: 1, pages: 0 })
  })
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

describe("the IS_EXPERIMENTAL flag", () => {
  const updates = (channel: Promise<UpdateChannel>) => ({
    onOffer: () => () => {},
    openPage: () => {},
    channel: { get: () => channel, set: () => {} },
  })
  const flag = (ui: ReturnType<typeof createUiStore>): boolean =>
    ui.getSnapshot().flags.IS_EXPERIMENTAL
  const into = (ui: ReturnType<typeof createUiStore>) => (on: boolean) =>
    setFeatureFlag(ui, "IS_EXPERIMENTAL", on)

  it("is on where the desktop app follows early builds", async () => {
    const ui = createUiStore(initial())
    watchExperimental(updates(Promise.resolve("early")), into(ui))
    expect(flag(ui)).toBe(false)
    await vi.waitFor(() => expect(flag(ui)).toBe(true))
  })

  it("stays off on stable, where the app offers no choice, or fails to say", async () => {
    const ui = createUiStore(initial())
    watchExperimental(updates(Promise.resolve("stable")), into(ui))
    watchExperimental(undefined, into(ui))
    watchExperimental(updates(Promise.reject(new Error("no"))), into(ui))
    await Promise.resolve()
    await Promise.resolve()
    expect(flag(ui)).toBe(false)
  })

  it("is not set once the watch is stopped", async () => {
    const ui = createUiStore(initial())
    watchExperimental(updates(Promise.resolve("early")), into(ui))()
    await Promise.resolve()
    expect(flag(ui)).toBe(false)
  })

  it("turns on and off, and leaves the state as it was when it doesn't change", () => {
    const ui = createUiStore(initial())
    const before = ui.getSnapshot()
    setFeatureFlag(ui, "IS_EXPERIMENTAL", false)
    expect(ui.getSnapshot()).toBe(before)
    setFeatureFlag(ui, "IS_EXPERIMENTAL", true)
    expect(flag(ui)).toBe(true)
    setFeatureFlag(ui, "IS_EXPERIMENTAL", false)
    expect(flag(ui)).toBe(false)
  })

  it("holds the chat view back while it is off", () => {
    const { preferences } = initial()
    const on = { ...preferences, chatView: true }
    expect(chatViewOn({ preferences: on, flags: { IS_EXPERIMENTAL: false } })).toBe(false)
    expect(chatViewOn({ preferences: on, flags: { IS_EXPERIMENTAL: true } })).toBe(true)
    expect(chatViewOn({ preferences, flags: { IS_EXPERIMENTAL: true } })).toBe(false)
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
