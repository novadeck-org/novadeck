import type { ProjectWindows, ProjectWindowsState } from "@novadeck/core/desktop/project-windows"
import { createTerminalState } from "@novadeck/core/state"
import { terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type { Workspace } from "@novadeck/core/types"

import { context, describe, expect, it } from "../test"
import { openCommands } from "../test/commands"
import {
  hasVoice,
  shownElsewhere,
  watchProjectWindows,
  watchWindowTitle,
  windowTitle,
} from "./project-windows"

// The fixture's Project, and Other beside it.
const twoProjects = (): Workspace => {
  const workspace = workspaceFixture()
  const [first] = workspace.projects
  const other = {
    ...first!,
    id: "other",
    name: "Other",
    activeSessionId: "other-session",
    history: [
      {
        id: "other-session",
        name: "initial",
        visitedAt: 0,
        state: createTerminalState([terminalFixture(7, "~/other")], "grid", "grid"),
      },
    ],
  }
  return { ...workspace, projects: [first!, other] }
}

const other = (app: ReturnType<typeof openCommands>) =>
  app.workspace.getSnapshot().projects.find(({ id }) => id === "other")!

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

describe("another window's project", () => {
  it("is marked where the app opens windows, and never this window's own", () => {
    const { windows } = appWindows()
    const app = openCommands()
    app.ui.update((state) => ({ ...state, windows: { elsewhere: ["other"], voice: false } }))
    expect(shownElsewhere(app.ui.getSnapshot(), windows, "other")).toBe(true)
    expect(shownElsewhere(app.ui.getSnapshot(), windows, "project")).toBe(false)
    expect(shownElsewhere(app.ui.getSnapshot(), undefined, "other")).toBe(false)
    expect(hasVoice(app.ui.getSnapshot())).toBe(false)
  })
})

describe("following the app's windows", () => {
  it("keeps what the other windows show, says what this one shows, and that it has shared", () => {
    const { backend, told, say } = appWindows()
    const app = openCommands()
    const stop = watchProjectWindows(backend, app.workspace, app.ui)
    expect(told).toEqual(["show project of project"])
    expect(app.ui.getSnapshot().windowsShared).toBe(false)
    say({ elsewhere: ["other"], voice: false })
    expect(app.ui.getSnapshot().windows).toEqual({ elsewhere: ["other"], voice: false })
    expect(told).toEqual(["show project of project", "showing project"])
    say({ elsewhere: [], voice: true })
    expect(app.ui.getSnapshot().windowsShared).toBe(true)
    stop()
  })

  it("tells the app when the project on screen changes, and the runner only while another window shows one", () => {
    const { backend, told, say } = appWindows()
    const app = openCommands({ workspace: twoProjects() })
    const stop = watchProjectWindows(backend, app.workspace, app.ui)
    told.length = 0
    app.commands.switchProject(other(app))
    expect(told).toEqual(["show other of project,other"])
    say({ elsewhere: ["project"], voice: true })
    expect(told).toEqual(["show other of project,other", "showing other"])
    say({ elsewhere: [], voice: true })
    expect(told).toEqual(["show other of project,other", "showing other", "showing null"])
    stop()
  })

  it("says whether another window exists when it shows a project", () => {
    const { backend, say } = appWindows()
    const app = openCommands({ workspace: twoProjects() })
    const shown: [string | null, boolean | undefined][] = []
    const watched = {
      ...backend,
      showingProject: (id: string | null, others?: boolean) => void shown.push([id, others]),
    }
    const stop = watchProjectWindows(watched, app.workspace, app.ui)
    say({ elsewhere: ["project"], voice: true })
    app.commands.switchProject(other(app))
    say({ elsewhere: [], voice: true })
    expect(shown).toEqual([
      ["project", true],
      ["other", true],
      [null, false],
    ])
    stop()
  })

  it("does nothing without a desktop app that opens windows", () => {
    const app = openCommands()
    expect(() => watchProjectWindows({}, app.workspace, app.ui)()).not.toThrow()
  })
})

describe("the window's title", () => {
  it("names the project the window shows, else the app", () => {
    expect(windowTitle("Storefront")).toBe("Storefront — Novadeck")
    expect(windowTitle(undefined)).toBe("Novadeck")
  })

  it("follows the project on screen, where the app opens windows", () => {
    const { windows } = appWindows()
    const app = openCommands()
    const view = { document: { title: "Novadeck" } }
    const stop = watchWindowTitle(view, windows, app.workspace)
    expect(view.document.title).toBe("Project — Novadeck")
    stop()
    expect(view.document.title).toBe("Novadeck")
    expect(watchWindowTitle(view, undefined, app.workspace)).toBeTypeOf("function")
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
