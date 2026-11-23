import type { ProjectWindows, ProjectWindowsState } from "@novadeck/core/desktop/project-windows"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { openCommands } from "../test/commands"
import {
  flagGraceMs,
  hasVoice,
  projectWindowsOn,
  shownElsewhere,
  watchProjectWindows,
  watchWindowTitle,
  windowTitle,
} from "./project-windows"

afterEach(() => void vi.useRealTimers())

// The app's windows as the page sees them: what it was told, and the state and places it can
// be given.
const appWindows = () => {
  const told: string[] = []
  const states = new Set<(state: ProjectWindowsState) => void>()
  const windows: ProjectWindows = {
    onState: (listener) => {
      states.add(listener)
      return () => void states.delete(listener)
    },
    show: (id, known) => void told.push(`show ${id} of ${known.join(",")}`),
    use: (on) => void told.push(`use ${on}`),
    open: () => {},
    handOff: () => {},
    onNavigate: () => () => {},
    extra: false,
  }
  // What the backend is told besides: the project this window shows, for the runner.
  const backend = {
    projectWindows: windows,
    showingProject: (id: string | null) => void told.push(`showing ${id}`),
  }
  return {
    windows,
    backend,
    told,
    say: (state: ProjectWindowsState) => states.forEach((fn) => fn(state)),
  }
}

const featureOn = (app: ReturnType<typeof openCommands>, on: boolean): void =>
  void app.ui.update((state) => ({
    ...state,
    flags: { IS_EXPERIMENTAL: on },
    preferences: { ...state.preferences, projectWindows: on },
  }))

describe("whether project windows are on", () => {
  it("takes a desktop app that opens them, Experimental, and the switch", () => {
    const { windows } = appWindows()
    const app = openCommands()
    const state = () => app.ui.getSnapshot()
    expect(projectWindowsOn(state(), windows)).toBe(false)
    featureOn(app, true)
    expect(projectWindowsOn(state(), windows)).toBe(true)
    expect(projectWindowsOn(state(), undefined)).toBe(false)
    app.ui.update((current) => ({ ...current, flags: { IS_EXPERIMENTAL: false } }))
    expect(projectWindowsOn(state(), windows)).toBe(false)
  })

  it("marks a project another window shows only while they are on", () => {
    const { windows } = appWindows()
    const app = openCommands()
    app.ui.update((state) => ({ ...state, windows: { elsewhere: ["other"], voice: false } }))
    expect(shownElsewhere(app.ui.getSnapshot(), windows, "other")).toBe(false)
    featureOn(app, true)
    expect(shownElsewhere(app.ui.getSnapshot(), windows, "other")).toBe(true)
    expect(shownElsewhere(app.ui.getSnapshot(), windows, "project")).toBe(false)
    expect(hasVoice(app.ui.getSnapshot())).toBe(false)
  })
})

describe("following the app's windows", () => {
  it("keeps what the other windows show, and says what this one shows", () => {
    const { backend, told, say } = appWindows()
    const app = openCommands()
    const stop = watchProjectWindows(backend, app.workspace, app.ui)
    expect(told).toEqual(["show project of project", "use false"])
    say({ elsewhere: ["other"], voice: false })
    expect(app.ui.getSnapshot().windows).toEqual({ elsewhere: ["other"], voice: false })
    stop()
  })

  it("tells the app when the project on screen changes, and when the switch does", () => {
    const { backend, told } = appWindows()
    const app = openCommands()
    const stop = watchProjectWindows(backend, app.workspace, app.ui)
    told.length = 0
    featureOn(app, true)
    expect(told).toEqual(["showing project", "use true"])
    stop()
  })

  it("waits for Experimental before it says the switch is off, so a launch keeps its windows", () => {
    vi.useFakeTimers()
    const { backend, told } = appWindows()
    const app = openCommands()
    app.ui.update((state) => ({
      ...state,
      preferences: { ...state.preferences, projectWindows: true },
    }))
    const stop = watchProjectWindows(backend, app.workspace, app.ui)
    expect(told).toEqual(["show project of project"])
    app.ui.update((state) => ({ ...state, flags: { IS_EXPERIMENTAL: true } }))
    expect(told).toEqual(["show project of project", "showing project", "use true"])
    stop()
  })

  it("says it is off once Experimental has had its time and is not on", () => {
    vi.useFakeTimers()
    const { backend, told } = appWindows()
    const app = openCommands()
    app.ui.update((state) => ({
      ...state,
      preferences: { ...state.preferences, projectWindows: true },
    }))
    const stop = watchProjectWindows(backend, app.workspace, app.ui)
    vi.advanceTimersByTime(flagGraceMs)
    expect(told).toEqual(["show project of project", "use false"])
    stop()
  })

  it("says whether another window exists when it leaves a project", () => {
    const { backend, say } = appWindows()
    const app = openCommands()
    app.ui.update((state) => ({
      ...state,
      flags: { IS_EXPERIMENTAL: true },
      preferences: { ...state.preferences, projectWindows: true },
    }))
    const shown: [string | null, boolean | undefined][] = []
    const watched = {
      ...backend,
      showingProject: (id: string | null, others?: boolean) => void shown.push([id, others]),
    }
    const stop = watchProjectWindows(watched, app.workspace, app.ui)
    say({ elsewhere: ["other"], voice: true })
    app.ui.update((state) => ({ ...state }))
    expect(shown[0]).toEqual(["project", false])
    stop()
  })

  it("does nothing without a desktop app that opens windows", () => {
    const app = openCommands()
    expect(() => watchProjectWindows({}, app.workspace, app.ui)()).not.toThrow()
  })
})

describe("the window's title", () => {
  it("names the project while project windows are on, else the app", () => {
    expect(windowTitle("Storefront", true)).toBe("Storefront — Novadeck")
    expect(windowTitle("Storefront", false)).toBe("Novadeck")
    expect(windowTitle(undefined, true)).toBe("Novadeck")
  })

  it("follows the project on screen and the switch", () => {
    const { windows } = appWindows()
    const app = openCommands()
    const view = { document: { title: "Novadeck" } }
    const stop = watchWindowTitle(view, windows, app.workspace, app.ui)
    expect(view.document.title).toBe("Novadeck")
    featureOn(app, true)
    expect(view.document.title).toBe("Project — Novadeck")
    stop()
    expect(view.document.title).toBe("Novadeck")
  })
})

context("a window that is not the app's first", () => {
  it("leaves the one-time offers to the first", async () => {
    const { initialUi } = await import("./ui-store")
    const base = openCommands().ui.getSnapshot()
    const first = initialUi({ location: base.location, preferences: base.preferences })
    const extra = initialUi({
      location: base.location,
      preferences: base.preferences,
      extraWindow: true,
    })
    expect([first.chatOfferHeld, first.addonOffer]).toEqual([false, null])
    expect([extra.chatOfferHeld, extra.addonOffer]).toEqual([true, "none"])
  })
})
