import { describe, expect, it } from "vitest"

import { createTerminalState } from "../model/state"
import { createWorkspaceStore } from "../model/store"
import type { PreferencesValue, Workspace } from "../model/types"
import { appearance, terminalFixture, workspaceWithWindow } from "../test/fixtures"
import { resolveRoute, routeUrl, workspaceRoute } from "./routing"

const preferences: PreferencesValue = {
  fontSize: 13,
  enabledViews: ["focus", "grid", "canvas"],
  appearance,
  notifyFinished: true,
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
    const resolved = resolveRoute(workspaceWithWindow(), location, preferences, 1)
    expect(resolved.route).toMatchObject({ terminal: "w1" })
  })

  it("projects URL navigation without changing the store during a render", () => {
    const store = createWorkspaceStore(fixture())
    const before = store.getSnapshot()
    const location = { pathname: "/projects/project/sessions/initial/canvas", search: "?terminal=" }
    const resolved = resolveRoute(before, location, preferences, 1)
    expect(resolved.route).toMatchObject({ view: "canvas", terminal: "" })
    expect(store.getSnapshot()).toBe(before)
    store.dispatch({
      type: "terminal/rename",
      target,
      terminalId: "01",
      name: "Changed before commit",
    })
    store.transact((current) => resolveRoute(current, location, preferences, 1).actions)
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
    )
    expect(routeUrl(resolved.route)).toBe(
      "/projects/project/sessions/initial/grid?terminal=01&dialog=preferences&section=shortcuts",
    )
  })
})
