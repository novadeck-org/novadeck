import { createTerminalState } from "@novadeck/core/state"
import { createStore, createWorkspaceStore } from "@novadeck/core/store"
import { appearance, terminalFixture, workspaceWithWindow } from "@novadeck/core/testing"
import type { PreferencesValue, Workspace } from "@novadeck/core/types"
import { describe, expect, it } from "vitest"

import {
  availablePanels,
  historyShown,
  resolveRoute,
  routeUrl,
  filesShown,
  workspaceRoute,
} from "./routing"

const preferences: PreferencesValue = {
  fontSize: 13,
  enabledViews: ["focus", "grid", "canvas"],
  appearance,
  notifyNeeds: true,
  notifyFinished: true,
  sound: true,
  soundVolume: 0.6,
  soundChoice: "theme",
  ligatures: false,
  screenReader: "auto",
  chatView: false,
  agentAvatars: false,
  onboardingTour: false,
  keepAwakeOffered: false,
  keepAwake: true,
  appScale: 100,
}
const target = { projectId: "project", workspaceSessionId: "initial" }
const fixture = (): Workspace => ({
  activeProjectId: "project",
  projects: [
    {
      id: "project",
      name: "Project",
      directory: "~/project",
      activeSessionId: "initial",
      history: [
        {
          id: "initial",
          name: "Session",
          visitedAt: 0,
          state: createTerminalState([terminalFixture(1, "~/project")], "grid", "grid"),
        },
      ],
    },
  ],
})

describe("route reconciliation", () => {
  it("selects an undocked window the URL names, as it would a terminal", () => {
    const location = { pathname: "/projects/project/sessions/initial/grid", search: "?terminal=w1" }
    const resolved = resolveRoute(
      workspaceWithWindow(),
      location,
      preferences,
      1,
      availablePanels(true),
    )
    expect(resolved.route).toMatchObject({ terminal: "w1" })
  })

  it("projects URL navigation without changing the store during a render", () => {
    const store = createWorkspaceStore(fixture())
    const before = store.getSnapshot()
    const location = { pathname: "/projects/project/sessions/initial/canvas", search: "?terminal=" }
    const resolved = resolveRoute(before, location, preferences, 1, availablePanels(true))
    expect(resolved.route).toMatchObject({ view: "canvas", terminal: "" })
    expect(store.getSnapshot()).toBe(before)
    store.dispatch({
      type: "terminal/rename",
      target,
      terminalId: "01",
      name: "Changed before commit",
    })
    store.transact(
      (current) => resolveRoute(current, location, preferences, 1, availablePanels(true)).actions,
    )
    expect(store.getSnapshot().projects[0]!.history[0]!.state.roster.terminals[0]!.name).toBe(
      "Changed before commit",
    )
    expect(workspaceRoute(store.getSnapshot())).toMatchObject({ view: "canvas", terminal: "" })
  })

  it("builds navigation from the transaction result after an earlier dispatch", () => {
    const store = createWorkspaceStore(fixture())
    store.dispatch({ type: "terminal/rename", target, terminalId: "01", name: "Saved" })
    const next = store.transact([
      { type: "terminal/add", target, terminal: terminalFixture(2, "~/project") },
    ])
    expect(routeUrl(workspaceRoute(next))).toBe(
      "/projects/project/sessions/initial/grid?terminal=02",
    )
    expect(next.projects[0]!.history[0]!.state.roster.terminals[0]!.name).toBe("Saved")
  })

  it("replaces obsolete selections and disabled views with valid URL values", () => {
    const location = {
      pathname: "/projects/project/sessions/initial/canvas",
      search: "?terminal=gone&dialog=preferences&section=shortcuts",
    }
    const resolved = resolveRoute(
      fixture(),
      location,
      { ...preferences, enabledViews: ["grid"] },
      1,
      availablePanels(true),
    )
    expect(routeUrl(resolved.route)).toBe(
      "/projects/project/sessions/initial/grid?terminal=01&dialog=preferences&section=shortcuts",
    )
  })

  describe("for the Preferences tab", () => {
    const pathname = "/projects/project/sessions/initial/grid"
    const sectionOf = (search: string) =>
      resolveRoute(fixture(), { pathname, search }, preferences, 1, availablePanels(true)).route
        .section

    it("is none where the URL names none, so Preferences opens its own first choice", () => {
      expect(sectionOf("?terminal=01&dialog=preferences")).toBeNull()
      expect(sectionOf("?terminal=01")).toBeNull()
    })

    it("is the page the URL names", () => {
      expect(sectionOf("?terminal=01&dialog=preferences&section=agents")).toBe("agents")
      expect(sectionOf("?terminal=01&dialog=preferences&section=terminal")).toBe("terminal")
    })

    it("is Notifications for General, the page that held its notifications before it went", () => {
      expect(sectionOf("?terminal=01&dialog=preferences&section=general")).toBe("notifications")
    })

    it("is Appearance where the name was never a page's", () => {
      expect(sectionOf("?terminal=01&dialog=preferences&section=nothing")).toBe("appearance")
    })

    it("is kept in the URL where it is named, and left out where none is", () => {
      const route = workspaceRoute(fixture())
      const open = { ...route, dialog: "preferences" as const }

      expect(routeUrl({ ...open, section: null })).toBe(
        "/projects/project/sessions/initial/grid?terminal=01&dialog=preferences",
      )
      expect(routeUrl({ ...open, section: "notifications" })).toBe(
        "/projects/project/sessions/initial/grid?terminal=01&dialog=preferences&section=notifications",
      )
    })
  })

  it("shows the Files panel only where the backend reads the projects' files", () => {
    const pathname = "/projects/project/sessions/initial/grid"
    const location = { pathname, search: "?terminal=01&panel=files" }

    const without = resolveRoute(fixture(), location, preferences, 1, availablePanels(false))
    const withFiles = resolveRoute(fixture(), location, preferences, 1, availablePanels(true))

    expect(without.route.panel).toBe("terminals")
    expect(withFiles.route.panel).toBe("files")
  })

  it("opens a panel a URL names by its former id under its new one", () => {
    const pathname = "/projects/project/sessions/initial/grid"
    const panels = availablePanels(true, false, true)
    const at = (panel: string) =>
      resolveRoute(
        fixture(),
        { pathname, search: `?terminal=01&panel=${panel}` },
        preferences,
        1,
        panels,
      ).route.panel

    expect(at("source")).toBe("files")
    expect(at("changes")).toBe("worktrees")
  })

  it("shows the History panel only where the backend keeps closed terminals", () => {
    const pathname = "/projects/project/sessions/initial/grid"
    const location = { pathname, search: "?terminal=01&panel=history" }

    const without = resolveRoute(fixture(), location, preferences, 1, availablePanels(true))
    const withHistory = resolveRoute(
      fixture(),
      location,
      preferences,
      1,
      availablePanels(true, true),
    )

    expect(without.route.panel).toBe("terminals")
    expect(withHistory.route.panel).toBe("history")
    expect(historyShown({})).toBe(false)
    expect(
      historyShown({
        history: { state: createStore({ rows: [] }), list: () => Promise.resolve([]) },
      }),
    ).toBe(true)
  })

  describe("deciding whether the app shows the Files panel", () => {
    const files = {
      state: createStore({ projects: {} }),
      list: () => Promise.resolve({ entries: [], truncated: false }),
    }

    it("shows it on a backend that reads the projects' files", () => {
      expect(filesShown({ files })).toBe(true)
    })

    it("hides it on a backend without one", () => {
      expect(filesShown({})).toBe(false)
    })
  })

  it("round-trips the sidebar panel through the URL", () => {
    const pathname = "/projects/project/sessions/initial/grid"
    for (const panel of ["sessions", "inbox"] as const) {
      const { route } = resolveRoute(
        fixture(),
        { pathname, search: `?terminal=01&panel=${panel}` },
        preferences,
        1,
        availablePanels(true),
      )
      expect(route.panel).toBe(panel)
      expect(routeUrl(route)).toBe(`${pathname}?terminal=01&panel=${panel}`)
    }
    const { route } = resolveRoute(
      fixture(),
      { pathname, search: "?terminal=01&panel=nowhere" },
      preferences,
      1,
      availablePanels(true),
    )
    expect(routeUrl(route)).toBe(`${pathname}?terminal=01`)
  })
})
