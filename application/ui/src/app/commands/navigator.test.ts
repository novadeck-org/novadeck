import { createWorkspaceStore } from "../../model/store"
import type { PreferencesValue, Workspace } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { appearance, workspaceFixture } from "../../test/fixtures"
import { resolveRoute } from "../routing"
import { createUiStore, initialUi } from "../ui-store"
import { createNavigator, syncLocation, type RouterNavigate } from "./navigator"

const preferences: PreferencesValue = {
  fontSize: 13,
  enabledViews: ["focus", "grid", "canvas"],
  appearance,
}
const base = "/projects/project/sessions/initial/grid"

// A navigator over fresh stores, opened at `search`, recording what it asks the router for.
const open = (search = "?terminal=01", workspace: Workspace = workspaceFixture()) => {
  const location = { pathname: base, search }
  const resolved = resolveRoute(workspace, location, preferences, 0)
  const store = createWorkspaceStore(resolved.workspace)
  const ui = createUiStore(
    initialUi({
      location: { route: resolved.route, dialogDepth: 0, navigationType: "POP" },
      preferences,
    }),
  )
  const services = { workspace: store, ui, now: () => 1 }
  const navigator = createNavigator(services)
  type Options = { readonly replace: boolean; readonly state: unknown } | undefined
  const calls: { to: string | number; options: Options; selected: string }[] = []
  const selected = (): string => store.getSnapshot().projects[0]!.history[0]!.state.selected
  navigator.bind(((to: string | number, options?: Options) => {
    calls.push({ to, options, selected: selected() })
  }) as RouterNavigate)
  return {
    store,
    ui,
    services,
    navigator,
    calls,
    selected,
    location: () => ui.getSnapshot().location,
  }
}

describe("workspace navigator", () => {
  context("when opening dialogs", () => {
    it("counts the entries each dialog adds above the background", () => {
      const { navigator, calls, location } = open()
      navigator.go({ dialog: "preferences", section: "general" })
      expect(location().dialogDepth).toBe(1)
      navigator.go({ section: "shortcuts" })
      expect(location().dialogDepth).toBe(2)
      navigator.go({ section: "general" }, true)
      expect(location().dialogDepth).toBe(2)
      expect(calls.map(({ options }) => options?.state)).toEqual([
        { dialogDepth: 1 },
        { dialogDepth: 2 },
        { dialogDepth: 2 },
      ])
      expect(calls.map(({ options }) => options?.replace)).toEqual([false, false, true])
    })

    it("returns through history when the dialog has a background entry", () => {
      const { navigator, calls } = open()
      navigator.go({ dialog: "search" })
      navigator.go({ dialog: "preferences" })
      navigator.closeDialog()
      expect(calls.at(-1)!.to).toBe(-2)
    })

    it("replaces a dialog opened from a direct link", () => {
      const { navigator, calls, location } = open("?terminal=01&dialog=search")
      navigator.closeDialog()
      expect(calls).toEqual([
        { to: `${base}?terminal=01`, options: { replace: true, state: null }, selected: "01" },
      ])
      expect(location().route.dialog).toBeNull()
    })
  })

  context("when the same destination is requested twice before rendering", () => {
    it("navigates once", () => {
      const { navigator, calls } = open()
      navigator.go({ terminal: "02" })
      navigator.go({ terminal: "02" })
      expect(calls).toHaveLength(1)
    })
  })

  context("when asked for the location it already shows", () => {
    it("does nothing", () => {
      const { navigator, calls } = open()
      navigator.go({ terminal: "01" })
      expect(calls).toEqual([])
    })
  })

  context("when navigating", () => {
    it("commits the destination's selection and route before asking the router", () => {
      const { navigator, calls, location } = open()
      navigator.go({ terminal: "02" })
      expect(calls).toEqual([
        { to: `${base}?terminal=02`, options: { replace: false, state: null }, selected: "02" },
      ])
      expect(location()).toMatchObject({ navigationType: "PUSH", route: { terminal: "02" } })
    })

    it("commits workspace actions first and navigates to the route they produce", () => {
      const { navigator, calls, store } = open()
      navigator.navigateWorkspace(
        [
          {
            type: "terminal/close",
            target: { projectId: "project", workspaceSessionId: "initial" },
            terminalId: "01",
          },
        ],
        {},
        true,
      )
      expect(store.getSnapshot().projects[0]!.history[0]!.state.roster.terminals).toHaveLength(1)
      expect(calls).toEqual([
        { to: `${base}?terminal=02`, options: { replace: true, state: null }, selected: "02" },
      ])
    })
  })

  context("when the router reports a location the navigator did not produce", () => {
    it("reconciles it against the latest workspace", () => {
      const { services, selected, location } = open()
      syncLocation(services, {
        location: { pathname: base, search: "?terminal=02&panel=sessions" },
        navigationType: "POP",
        dialogDepth: 0,
      })
      expect(selected()).toBe("02")
      expect(location()).toMatchObject({
        navigationType: "POP",
        route: { terminal: "02", panel: "sessions" },
      })
    })

    it("starts the presentation over after Back or Forward to another selection", () => {
      const { services, ui } = open()
      const pulse = (): number => ui.getSnapshot().shell.navigation.count
      ui.update((state) => ({ ...state, shell: { ...state.shell, sidebar: true } }))
      syncLocation(services, {
        location: { pathname: base, search: "?terminal=02" },
        navigationType: "POP",
        dialogDepth: 0,
      })
      expect(pulse()).toBe(2)
      expect(ui.getSnapshot().shell.sidebar).toBe(false)
      syncLocation(services, {
        location: { pathname: base, search: "?terminal=01" },
        navigationType: "PUSH",
        dialogDepth: 0,
      })
      expect(pulse()).toBe(2)
      syncLocation(services, {
        location: { pathname: base, search: "?terminal=01&dialog=search" },
        navigationType: "POP",
        dialogDepth: 0,
      })
      expect(pulse()).toBe(2)
    })

    it("falls back to the remembered selection for a terminal that no longer exists", () => {
      const { services, location } = open()
      syncLocation(services, {
        location: { pathname: base, search: "?terminal=gone" },
        navigationType: "POP",
        dialogDepth: 0,
      })
      expect(location().route.terminal).toBe("01")
    })
  })
})
