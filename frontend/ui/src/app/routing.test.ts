import { createTerminalState } from "@novadeck/core/state"
import { createStore, createWorkspaceStore } from "@novadeck/core/store"
import { appearance, terminalFixture, workspaceWithWindow } from "@novadeck/core/testing"
import type { PreferencesValue, Workspace } from "@novadeck/core/types"
import { describe, expect, it } from "vitest"

import { availablePanels, resolveRoute, routeUrl, sourceShown, workspaceRoute } from "./routing"

const preferences: PreferencesValue = {
  fontSize: 13,
  enabledViews: ["focus", "grid", "canvas"],
  appearance,
  notifyFinished: true,
  ligatures: false,
  chatView: false,
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

  it("shows the Source panel only where the backend has a source", () => {
    const pathname = "/projects/project/sessions/initial/grid"
    const location = { pathname, search: "?terminal=01&panel=source" }

    const without = resolveRoute(fixture(), location, preferences, 1, availablePanels(false))
    const withSource = resolveRoute(fixture(), location, preferences, 1, availablePanels(true))

    expect(without.route.panel).toBe("terminals")
    expect(withSource.route.panel).toBe("source")
  })

  describe("deciding whether the app shows the Source panel", () => {
    const source = { state: createStore({ projects: {} }) }

    it("shows it on a demo backend that has a source", () => {
      expect(sourceShown({ demo: true, source })).toBe(true)
    })

    it("hides it on any other backend, even one that has a source", () => {
      expect(sourceShown({ source })).toBe(false)
    })

    it("hides it on a demo backend without a source", () => {
      expect(sourceShown({ demo: true })).toBe(false)
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
