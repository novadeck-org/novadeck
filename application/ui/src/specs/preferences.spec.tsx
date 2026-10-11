import { afterEach, describe as context, describe, expect, it, vi } from "vitest"
import { page, type Locator } from "vitest/browser"

import { pageScheme, saveFromAnotherWindow, systemScheme } from "./support/appearance"
import { escapeFrom, expectFocusWithin, preferencesDialog } from "./support/keyboard"
import { openWorkspace, reloadWorkspace, terminal, view, viewSwitcher } from "./support/workspace"

const openPreferences = async (): Promise<void> => {
  await page.getByRole("button", { name: "Workspace preferences" }).click()
  await expectFocusWithin(preferencesDialog())
}

const closePreferences = async (): Promise<void> => {
  await preferencesDialog().getByRole("button", { name: "Close preferences" }).click()
  await expect.element(preferencesDialog()).not.toBeInTheDocument()
}

const tab = (name: "General" | "Addons" | "Shortcuts"): Locator =>
  preferencesDialog().getByRole("tab", { name })

const viewModeChoice = (name: "Focus" | "Grid" | "Canvas"): Locator =>
  preferencesDialog().getByRole("group", { name: "View modes" }).getByRole("checkbox", { name })

/** The shortcuts listed in a group, as "action: keys" in the order shown. */
const shortcutList = (group: "Anywhere" | "Navigating"): string[] => {
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

const ligaturesSwitch = (): Locator =>
  preferencesDialog().getByRole("switch", { name: "Ligatures" })

/** A style of a terminal's output text, as drawn. */
const outputStyle = (property: "fontVariantLigatures" | "fontFamily"): string =>
  getComputedStyle(
    terminal("Checkout implementation")
      .getByText("Nothing to commit, working tree clean.")
      .element(),
  )[property]

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

  context("when choosing whether to join ligatures", () => {
    it("draws terminals in the bundled mono without them, then joins them once turned on", async () => {
      await openWorkspace()
      expect(outputStyle("fontFamily")).toMatch(/^"JetBrains Mono Variable"/)
      expect(outputStyle("fontVariantLigatures")).toBe("none")
      await openPreferences()
      await expect.element(ligaturesSwitch()).toHaveAttribute("aria-checked", "false")
      await ligaturesSwitch().click()
      await expect.element(ligaturesSwitch()).toHaveAttribute("aria-checked", "true")
      await closePreferences()

      await expect.poll(() => outputStyle("fontVariantLigatures")).toBe("normal")
      await reloadWorkspace()
      await expect.poll(() => outputStyle("fontVariantLigatures")).toBe("normal")
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
      await expect.element(shortcuts.getByRole("heading", { name: "Navigating" })).toBeVisible()
      await expect.element(shortcuts.getByRole("heading", { name: "Anywhere" })).toBeVisible()
      await expect
        .element(preferencesDialog().getByRole("tabpanel", { name: "General" }))
        .not.toBeInTheDocument()
    })
  })

  for (const [label, dismiss] of [
    ["Escape", () => escapeFrom(preferencesDialog())],
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

/** The Addons tab's panel. */
const addons = (): Locator => preferencesDialog().getByRole("tabpanel", { name: "Addons" })

describe("Preferences Addons", () => {
  const showAddons = async (): Promise<void> => {
    await openPreferences()
    await tab("Addons").click()
    await expect.element(tab("Addons")).toHaveAttribute("aria-selected", "true")
  }

  context("when voice input is not installed", () => {
    it("offers the models with their sizes, and installs with progress until it is on", async () => {
      await openWorkspace()
      await showAddons()

      await expect.element(addons().getByText(/never leaves it/)).toBeVisible()
      await expect.element(addons().getByText(/Most accurate, 99 languages/)).toBeVisible()
      await expect.element(addons().getByText(/Downloads 602 MB/)).toBeVisible()
      await addons().getByText("Small", { exact: true }).click()
      await expect.element(addons().getByText(/Faster without a GPU/)).toBeVisible()
      await expect.element(addons().getByText(/Downloads 218 MB/)).toBeVisible()
      await addons().getByRole("button", { name: "Install" }).click()

      await expect.element(addons().getByText(/Downloading engine/)).toBeVisible()
      await expect.element(addons().getByRole("progressbar")).toBeVisible()
      await expect.element(addons().getByRole("button", { name: "Cancel" })).toBeVisible()
      await expect.element(addons().getByText(/Downloading model/)).toBeVisible()

      const enabled = addons().getByRole("switch", { name: "Enabled" })
      // The demo's install takes a few seconds, its three steps together.
      await expect.element(enabled, { timeout: 10_000 }).toHaveAttribute("aria-checked", "true")
      await expect.element(addons().getByText(/Checked: a test clip took/)).toBeVisible()
      await expect.element(addons().getByRole("button", { name: /Install · 574 MB/ })).toBeVisible()
    })

    it("stops an install on Cancel", async () => {
      await openWorkspace()
      await showAddons()
      await addons().getByRole("button", { name: "Install" }).click()

      await addons().getByRole("button", { name: "Cancel" }).click()

      await expect.element(addons().getByRole("button", { name: "Install" })).toBeVisible()
      await expect.element(addons().getByRole("progressbar")).not.toBeInTheDocument()
    })
  })

  context("when voice input is installed", () => {
    const install = async (): Promise<void> => {
      await showAddons()
      await addons().getByRole("button", { name: "Install" }).click()
      await expect
        .element(addons().getByRole("switch", { name: "Enabled" }), { timeout: 10_000 })
        .toHaveAttribute("aria-checked", "true")
    }

    it("turns off, and asks before uninstalling, saying what it frees", async () => {
      await openWorkspace()
      await install()

      await addons().getByRole("switch", { name: "Enabled" }).click()
      await expect
        .element(addons().getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "false")

      await addons().getByRole("button", { name: "Uninstall" }).click()
      const confirm = page.getByRole("alertdialog", { name: "Uninstall voice input?" })
      await expect.element(confirm.getByText(/freeing 602 MB/)).toBeVisible()
      await confirm.getByRole("button", { name: "Cancel" }).click()
      await expect.element(confirm).not.toBeInTheDocument()
      await expect.element(addons().getByRole("switch", { name: "Enabled" })).toBeVisible()

      await addons().getByRole("button", { name: "Uninstall" }).click()
      await confirm.getByRole("button", { name: "Uninstall" }).click()
      await expect.element(addons().getByRole("button", { name: "Install" })).toBeVisible()
      // Removing it says it isn't wanted: it stays off, and the app stops offering it.
      await expect
        .element(addons().getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "false")
    })
  })

  context("when linked to directly", () => {
    it("opens on the Addons tab", async () => {
      await openWorkspace(
        "/projects/storefront/sessions/initial/focus?dialog=preferences&section=addons",
      )
      await expect.element(tab("Addons")).toHaveAttribute("aria-selected", "true")
    })
  })
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
        "Toggle Zen mode: CtrlShiftZ",
        "New terminal: CtrlShiftT",
        "New session: CtrlShiftN",
        "Toggle terminal sidebar: CtrlShiftE",
        "Toggle session sidebar: CtrlShiftS",
        "Open preferences: Ctrl,",
        "Navigate the workspace: ShiftEsc",
        "Hold to dictate: CtrlShiftM",
        "Terminal in that direction: CtrlShift↑↓←→",
        "Switch to pinned project: CtrlShift1–9",
      ])
    })

    it("lists the keys that work after Shift+Esc under Navigating", async () => {
      await openWorkspace()

      await showShortcuts()

      expect(shortcutList("Navigating")).toEqual([
        "Terminal in that direction: ↑↓←→",
        "Previous / next view: Shift←→",
        "Back into the terminal: EnterEsc",
        "Rename active terminal: F2",
        "Close active terminal: Delete",
        "Zoom canvas in / out: +−",
        "Fit canvas to all terminals: 0",
      ])
      await expect
        .element(
          preferencesDialog().getByText(
            "After Shift+Esc, until you type, press Enter or Esc, or click.",
          ),
        )
        .toBeVisible()
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
        "Toggle Zen mode: ⌘ShiftZ",
        "New terminal: ⌘T",
        "New session: ⌘ShiftN",
        "Toggle terminal sidebar: ⌘ShiftE",
        "Toggle session sidebar: ⌘ShiftS",
        "Open preferences: ⌘,",
        "Navigate the workspace: ShiftEsc",
        "Hold to dictate: CtrlShiftM",
        "Terminal in that direction: ⌘⌥↑↓←→",
        "Switch to pinned project: ⌘1–9",
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

  context("when a theme with only a dark scheme is chosen", () => {
    it("disables Mode and keeps the page dark while the system is light", async () => {
      await systemScheme("light")
      await openWorkspace()
      await expect.poll(pageScheme).toBe("light")
      await openPreferences()

      await preferencesDialog().getByRole("combobox", { name: "Theme" }).click()
      await preferencesDialog().getByRole("option", { name: "Phosphor Green" }).click()

      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Theme" }))
        .toHaveTextContent("Phosphor Green")
      await expect.element(modeChoice("Light")).toBeDisabled()
      await expect.element(modeChoice("Dark")).toBeChecked()
      await expect
        .element(preferencesDialog().getByRole("group", { name: "Mode" }))
        .toHaveAccessibleDescription("Phosphor Green comes only in dark.")
      await expect.poll(pageScheme).toBe("dark")
      expect(document.documentElement.dataset.theme).toBe("phosphor-green")
    })

    it("keeps the theme after reloading and gives Graphite its mode back", async () => {
      await systemScheme("light")
      await openWorkspace()
      await openPreferences()
      await chooseMode("Light")
      await preferencesDialog().getByRole("combobox", { name: "Theme" }).click()
      await preferencesDialog().getByRole("option", { name: "Phosphor Green" }).click()
      await expect.poll(pageScheme).toBe("dark")
      await closePreferences()

      // As a fresh load finds it: nothing on <html> until the app shows what it saved.
      document.documentElement.removeAttribute("data-theme")
      document.documentElement.removeAttribute("data-scheme")
      await reloadWorkspace()
      expect(document.documentElement.dataset).toMatchObject({
        theme: "phosphor-green",
        scheme: "dark",
      })
      await openPreferences()

      await preferencesDialog().getByRole("combobox", { name: "Theme" }).click()
      await preferencesDialog().getByRole("option", { name: "Graphite" }).click()

      await expect.poll(pageScheme).toBe("light")
      await expect.element(modeChoice("Light")).toBeChecked()
    })
  })

  context("when the saved theme is one the app does not know", () => {
    it("draws and lists Graphite, and keeps the saved id", async () => {
      await systemScheme("light")
      await openWorkspace()
      await openPreferences()

      const saved = JSON.parse(localStorage.getItem("novadeck.preferences") ?? "{}")
      saveFromAnotherWindow("novadeck.preferences", {
        ...saved,
        appearance: { theme: "ember", scheme: "light" },
      })

      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Theme" }))
        .toHaveTextContent("Graphite")
      expect(JSON.parse(localStorage.getItem("novadeck.preferences")!).appearance.theme).toBe(
        "ember",
      )
    })

    it("saves Graphite when the person picks it", async () => {
      await systemScheme("light")
      await openWorkspace()
      await openPreferences()
      const saved = JSON.parse(localStorage.getItem("novadeck.preferences") ?? "{}")
      saveFromAnotherWindow("novadeck.preferences", {
        ...saved,
        appearance: { theme: "ember", scheme: "light" },
      })
      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Theme" }))
        .toHaveTextContent("Graphite")

      await preferencesDialog().getByRole("combobox", { name: "Theme" }).click()
      await preferencesDialog().getByRole("option", { name: "Graphite" }).click()

      await expect
        .poll(() => JSON.parse(localStorage.getItem("novadeck.preferences")!).appearance.theme)
        .toBe("graphite")
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
