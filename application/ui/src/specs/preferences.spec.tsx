import { afterEach, describe as context, describe, expect, it, vi } from "vitest"
import { page, type Locator } from "vitest/browser"

import { pageScheme, saveFromAnotherWindow, systemScheme } from "./support/appearance"
import { expectFocusWithin, preferencesDialog } from "./support/keyboard"
import {
  openWorkspace,
  press,
  reloadWorkspace,
  terminal,
  view,
  viewSwitcher,
} from "./support/workspace"

const openPreferences = async (): Promise<void> => {
  await page.getByRole("button", { name: "Workspace preferences" }).click()
  await expectFocusWithin(preferencesDialog())
}

const closePreferences = async (): Promise<void> => {
  await preferencesDialog().getByRole("button", { name: "Close preferences" }).click()
  await expect.element(preferencesDialog()).not.toBeInTheDocument()
}

const tab = (name: "General" | "Shortcuts"): Locator =>
  preferencesDialog().getByRole("tab", { name })

const viewModeChoice = (name: "Focus" | "Grid" | "Canvas"): Locator =>
  preferencesDialog().getByRole("group", { name: "View modes" }).getByRole("checkbox", { name })

/** The shortcuts listed in a group, as "action: keys" in the order shown. */
const shortcutList = (group: "Anywhere" | "Workspace"): string[] => {
  const section = preferencesDialog().getByRole("region", { name: `${group} shortcuts` })
  const keys = section.getByRole("definition").elements()
  return section
    .getByRole("term")
    .elements()
    .map((action, index) => `${action.textContent}: ${keys[index]?.textContent}`)
}

const showShortcuts = async (): Promise<void> => {
  await openPreferences()
  await tab("Shortcuts").click()
  await expect.element(tab("Shortcuts")).toHaveAttribute("aria-selected", "true")
}

/** Rendered size of a terminal's output text. */
const outputTextSize = (): number =>
  parseFloat(
    getComputedStyle(
      terminal("Checkout implementation")
        .getByText("Nothing to commit, working tree clean.")
        .element(),
    ).fontSize,
  )

const modeChoice = (name: "System" | "Light" | "Dark"): Locator =>
  preferencesDialog().getByRole("radiogroup", { name: "Mode" }).getByRole("radio", { name })

/** Chooses a mode the way a person does: on its visible label. */
const chooseMode = async (name: "System" | "Light" | "Dark"): Promise<void> => {
  await preferencesDialog()
    .getByRole("radiogroup", { name: "Mode" })
    .getByText(name, { exact: true })
    .click()
  await expect.element(modeChoice(name)).toBeChecked()
}

const transcriptsSwitch = (): Locator =>
  preferencesDialog().getByRole("switch", { name: "Transcripts" })

describe("Preferences", () => {
  context("when choosing whether terminals keep transcripts", () => {
    it("keeps them by default, says they may hold secrets, and turns them off", async () => {
      await openWorkspace()
      await openPreferences()
      await expect.element(transcriptsSwitch()).toHaveAttribute("aria-checked", "true")
      await expect.element(transcriptsSwitch()).toHaveAccessibleDescription(/secrets/)
      await transcriptsSwitch().click()
      await expect.element(transcriptsSwitch()).toHaveAttribute("aria-checked", "false")
      await closePreferences()
      await openPreferences()
      await expect.element(transcriptsSwitch()).toHaveAttribute("aria-checked", "false")
    })
  })

  context("when opened from the header", () => {
    it("shows the General section with its settings", async () => {
      await openWorkspace()

      await openPreferences()

      await expect.element(tab("General")).toHaveAttribute("aria-selected", "true")
      await expect.element(tab("Shortcuts")).toHaveAttribute("aria-selected", "false")
      const general = preferencesDialog().getByRole("tabpanel", { name: "General" })
      await expect
        .element(general.getByRole("combobox", { name: "Theme" }))
        .toHaveTextContent("Graphite")
      await expect.element(modeChoice("System")).toBeChecked()
      await expect
        .element(general.getByRole("combobox", { name: "Text size" }))
        .toHaveTextContent("13px")
      await expect.element(viewModeChoice("Focus")).toBeChecked()
      await expect.element(viewModeChoice("Grid")).toBeChecked()
      await expect.element(viewModeChoice("Canvas")).toBeChecked()
    })
  })

  context("when choosing the Shortcuts tab", () => {
    it("replaces the General settings with the shortcut lists", async () => {
      await openWorkspace()

      await showShortcuts()

      const shortcuts = preferencesDialog().getByRole("tabpanel", { name: "Shortcuts" })
      await expect.element(shortcuts.getByRole("heading", { name: "Workspace" })).toBeVisible()
      await expect.element(shortcuts.getByRole("heading", { name: "Anywhere" })).toBeVisible()
      await expect
        .element(preferencesDialog().getByRole("tabpanel", { name: "General" }))
        .not.toBeInTheDocument()
    })
  })

  for (const [label, dismiss] of [
    ["Escape", () => press("{Escape}")],
    ["Close preferences", () => closePreferences()],
  ] as const) {
    context(`when dismissed with ${label}`, () => {
      it("closes and returns to the workspace", async () => {
        await openWorkspace()
        await openPreferences()

        await dismiss()

        await expect.element(preferencesDialog()).not.toBeInTheDocument()
        await expect.element(view("Focus")).toBeChecked()
      })
    })
  }
})

describe("shortcut list", () => {
  context("on Windows and Linux", () => {
    it("groups modifier shortcuts under Anywhere with Ctrl labels", async () => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32")
      await openWorkspace()

      await showShortcuts()

      expect(shortcutList("Anywhere")).toEqual([
        "Find a terminal: CtrlShiftK",
        "Recent terminals: CtrlTab",
        "Previous recent terminal: CtrlShiftTab",
        "Toggle Focus view: CtrlShiftEnter",
        "New terminal: CtrlShiftT",
        "New session: CtrlShiftN",
        "Toggle terminal sidebar: CtrlShift1",
        "Toggle session sidebar: CtrlShift2",
        "Open preferences: Ctrl,",
      ])
    })

    it("groups single keys under Workspace", async () => {
      await openWorkspace()

      await showShortcuts()

      expect(shortcutList("Workspace")).toEqual(
        expect.arrayContaining([
          "Find a terminal: /",
          "Toggle Focus view: F",
          "New terminal: T",
          "Toggle Zen mode: Z",
          "Toggle terminal sidebar: B",
          "Rename active terminal: F2",
          "Previous / next terminal: ↑↓",
          "Previous / next view: ←→",
          "Deselect, then hide sidebar: Esc",
        ]),
      )
    })
  })

  context("on macOS", () => {
    it("labels Command shortcuts with ⌘ and keeps Ctrl for recent terminals", async () => {
      // Chromium reports the host platform; stand in for a Mac so the app picks its bindings.
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
      await openWorkspace()

      await showShortcuts()

      expect(shortcutList("Anywhere")).toEqual([
        "Find a terminal: ⌘K",
        "Recent terminals: CtrlTab",
        "Previous recent terminal: CtrlShiftTab",
        "Toggle Focus view: ⌘Enter",
        "New terminal: ⌘T",
        "New session: ⌘ShiftN",
        "Toggle terminal sidebar: ⌘Shift1",
        "Toggle session sidebar: ⌘Shift2",
        "Open preferences: ⌘,",
      ])
    })
  })
})

describe("view mode preferences", () => {
  context("when a view is turned off", () => {
    it("removes it from the view switcher and keeps that after reopening", async () => {
      await openWorkspace()
      await openPreferences()

      await viewModeChoice("Grid").click()
      await closePreferences()

      await expect.element(view("Grid")).not.toBeInTheDocument()
      await expect.element(view("Canvas")).toBeInTheDocument()

      await reloadWorkspace()
      await expect.element(viewSwitcher().getByRole("radio")).toHaveLength(2)
      await expect.element(view("Grid")).not.toBeInTheDocument()
    })
  })

  context("when the current view is turned off", () => {
    it("moves to the next enabled view", async () => {
      await openWorkspace()
      await openPreferences()

      await viewModeChoice("Focus").click()
      await closePreferences()

      await expect.element(view("Focus")).not.toBeInTheDocument()
      await expect.element(view("Grid")).toBeChecked()
      await expect.element(terminal("Checkout implementation")).toBeVisible()
    })
  })

  context("when only one view is left", () => {
    it("keeps that view from being turned off", async () => {
      await openWorkspace()
      await openPreferences()

      await viewModeChoice("Grid").click()
      await viewModeChoice("Canvas").click()

      await expect.element(viewModeChoice("Focus")).toBeChecked()
      await expect.element(viewModeChoice("Focus")).toBeDisabled()
      await expect.element(viewModeChoice("Grid")).toBeEnabled()
    })
  })
})

describe("terminal text size preference", () => {
  context("when a larger size is chosen", () => {
    it("enlarges terminal text and keeps it after reopening", async () => {
      await openWorkspace()
      const initial = outputTextSize()
      await openPreferences()

      await preferencesDialog().getByRole("combobox", { name: "Text size" }).click()
      await preferencesDialog().getByRole("option", { name: "15px" }).click()
      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Text size" }))
        .toHaveTextContent("15px")
      await closePreferences()

      await expect.poll(outputTextSize).toBeGreaterThan(initial)

      await reloadWorkspace()
      await expect.poll(outputTextSize).toBeGreaterThan(initial)
      await openPreferences()
      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Text size" }))
        .toHaveTextContent("15px")
    })
  })
})

describe("appearance preference", () => {
  afterEach(() => systemScheme(null))

  context("when Dark is chosen", () => {
    it("draws the app dark and keeps it after reopening", async () => {
      await systemScheme("light")
      await openWorkspace()
      expect(pageScheme()).toBe("light")
      await openPreferences()

      await chooseMode("Dark")

      await expect.poll(pageScheme).toBe("dark")
      await closePreferences()
      // As a fresh load finds it: nothing on <html> until the app shows what it saved.
      document.documentElement.removeAttribute("data-theme")
      document.documentElement.removeAttribute("data-scheme")
      await reloadWorkspace()
      expect(document.documentElement.dataset).toMatchObject({ theme: "graphite", scheme: "dark" })
      await expect.poll(pageScheme).toBe("dark")
      await openPreferences()
      await expect.element(modeChoice("Dark")).toBeChecked()
    })
  })

  context("when Light is chosen", () => {
    it("stays light while the system is dark", async () => {
      await systemScheme("dark")
      await openWorkspace()
      await expect.poll(pageScheme).toBe("dark")
      await openPreferences()

      await chooseMode("Light")

      await expect.poll(pageScheme).toBe("light")
    })
  })

  context("when a theme with only a light scheme is chosen", () => {
    it("disables Mode and keeps the page light while the system is dark", async () => {
      await systemScheme("dark")
      await openWorkspace()
      await expect.poll(pageScheme).toBe("dark")
      await openPreferences()

      await preferencesDialog().getByRole("combobox", { name: "Theme" }).click()
      await preferencesDialog().getByRole("option", { name: "Sandstone" }).click()

      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Theme" }))
        .toHaveTextContent("Sandstone")
      await expect.element(modeChoice("Dark")).toBeDisabled()
      await expect.element(modeChoice("Light")).toBeChecked()
      await expect
        .element(preferencesDialog().getByRole("group", { name: "Mode" }))
        .toHaveAccessibleDescription("Sandstone comes only in light.")
      await expect.poll(pageScheme).toBe("light")
    })
  })

  context("when following the system", () => {
    it("changes with the system's scheme while the app is open", async () => {
      await systemScheme("light")
      await openWorkspace()
      expect(pageScheme()).toBe("light")

      await systemScheme("dark")
      await expect.poll(pageScheme).toBe("dark")

      await systemScheme("light")
      await expect.poll(pageScheme).toBe("light")
    })
  })

  context("when another window chooses a mode", () => {
    it("draws this window in it too and shows the choice", async () => {
      await systemScheme("light")
      await openWorkspace()
      await openPreferences()
      await expect.element(modeChoice("System")).toBeChecked()

      const saved = JSON.parse(localStorage.getItem("novadeck.preferences") ?? "{}")
      saveFromAnotherWindow("novadeck.preferences", {
        ...saved,
        appearance: { theme: "graphite", scheme: "dark" },
      })

      await expect.poll(pageScheme).toBe("dark")
      await expect.element(modeChoice("Dark")).toBeChecked()
    })
  })
})
