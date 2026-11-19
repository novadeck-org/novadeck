import { createWorkspaceStore } from "@novadeck/core/store"
import { appearance, workspaceFixture } from "@novadeck/core/testing"
import { describe, expect, it, vi } from "vitest"

import { watchActiveTerminal } from "./active-terminal"
import { createUiStore, initialUi } from "./ui-store"

const target = { projectId: "project", workspaceSessionId: "initial" }

const setup = () => {
  const workspace = createWorkspaceStore(workspaceFixture())
  workspace.dispatch({ type: "terminal/select", target, terminalId: "01" })
  const ui = createUiStore(
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
        ligatures: false,
        screenReader: "auto",
        chatView: false,
        agentAvatars: false,
        onboardingTour: false,
        appScale: 100,
        sound: true,
        soundVolume: 0.6,
        soundChoice: "theme",
      },
    }),
  )
  ui.update((state) => ({ ...state, pageFocused: true }))
  const report = vi.fn<(id: string | null) => void>()
  const desktop = { is: () => true, subscribe: () => () => {} }
  const stop = watchActiveTerminal(workspace, ui, report, desktop)
  return { workspace, ui, report, stop }
}

describe("the terminal the window reports as in use", () => {
  it("is the selected terminal, told once and again when the selection moves", () => {
    const { workspace, report } = setup()
    workspace.dispatch({ type: "terminal/select", target, terminalId: "01" })
    expect(report.mock.calls).toEqual([["01"]])
    workspace.dispatch({ type: "terminal/select", target, terminalId: "02" })
    expect(report.mock.calls).toEqual([["01"], ["02"]])
  })

  it("is none while the window has not the person's focus", () => {
    const { ui, report } = setup()
    ui.update((state) => ({ ...state, pageFocused: false }))
    ui.update((state) => ({ ...state, pageFocused: true }))
    expect(report.mock.calls).toEqual([["01"], [null], ["01"]])
  })

  it("tells none once stopped, as a window that closes", () => {
    const { report, stop } = setup()
    stop()
    expect(report.mock.calls.at(-1)).toEqual([null])
  })

  it("reports nothing where the backend takes none", () => {
    const { workspace, ui } = setup()
    expect(() => watchActiveTerminal(workspace, ui, undefined)()).not.toThrow()
  })
})
