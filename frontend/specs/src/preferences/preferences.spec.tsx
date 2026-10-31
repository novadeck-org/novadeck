import { afterEach, vi } from "vitest"
import { page, type Locator } from "vitest/browser"

import { pageScheme, saveFromAnotherWindow, systemScheme } from "../support/appearance"
import {
  closePreferences,
  escapeFrom,
  openPreferences,
  openPreferencesOn,
  preferencesDialog,
} from "../support/keyboard"
import {
  openWorkspace,
  outputTextElement,
  reloadWorkspace,
  terminal,
  view,
  viewSwitcher,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

/** Opens Preferences on its Appearance tab, which holds the theme, the mode and the sound. */
const openAppearance = async (): Promise<void> => {
  await openPreferencesOn("Appearance")
  await expect.element(tab("Appearance")).toHaveAttribute("aria-selected", "true")
}

const tab = (name: "General" | "Appearance" | "Addons" | "Shortcuts" | "About"): Locator =>
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
      outputTextElement("Checkout implementation", "Nothing to commit, working tree clean."),
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
    outputTextElement("Checkout implementation", "Nothing to commit, working tree clean."),
  )[property]

/**
 * Waits for the checkout terminal to draw its output: an opened workspace may not have yet,
 * on a busy machine, and a read of its text's style before then finds no row.
 */
const outputDrawn = async (): Promise<void> => {
  await expect.poll(() => outputStyle("fontFamily")).toBeTruthy()
}

describe("Preferences' version", () => {
  it("shows the version the backend gives, to copy", async () => {
    await openWorkspace()
    await openPreferences()
    await tab("About").click()
    const about = preferencesDialog().getByRole("tabpanel", { name: "About" })
    await expect.element(about.getByText("Version")).toBeVisible()
    await expect.element(about.getByText("0.0.79")).toBeVisible()
    expect(getComputedStyle(about.getByText("0.0.79").element()).userSelect).toBe("text")
  })

  it("names a build that carries 0.0.0 a development build", async () => {
    await openWorkspace("/?version=dev")
    await openPreferences()
    await tab("About").click()
    const about = preferencesDialog().getByRole("tabpanel", { name: "About" })
    await expect.element(about.getByText("Development build")).toBeVisible()
    await expect.element(about.getByText("0.0.0")).not.toBeInTheDocument()
  })

  it("offers the logs folder, which the backend opens", async () => {
    await openWorkspace()
    await openPreferences()
    await tab("About").click()
    const about = preferencesDialog().getByRole("tabpanel", { name: "About" })
    await expect.element(about.getByText("Logs", { exact: true })).toBeVisible()
    await expect
      .element(about.getByRole("button", { name: "Open logs folder" }))
      .toHaveAccessibleDescription(/Attach them to a bug report/)
  })

  it("leaves About out where the backend gives no version and keeps no logs", async () => {
    await openWorkspace("/?version=none")
    await openPreferences()
    await expect.element(tab("Appearance")).toBeVisible()
    await expect.element(tab("About")).not.toBeInTheDocument()
  })
})

describe("Preferences", () => {
  context("when choosing whether terminals keep transcripts", () => {
    it("keeps them by default, says they are saved encrypted, and turns them off", async () => {
      await openWorkspace()
      await openPreferences()
      await expect.element(transcriptsSwitch()).toHaveAttribute("aria-checked", "true")
      await expect
        .element(transcriptsSwitch())
        .toHaveAccessibleDescription(/Saved encrypted on this computer/)
      await transcriptsSwitch().click()
      await expect.element(transcriptsSwitch()).toHaveAttribute("aria-checked", "false")
      await closePreferences()
      await openPreferences()
      await expect.element(transcriptsSwitch()).toHaveAttribute("aria-checked", "false")
    })
  })

  context("when the app cannot keep transcripts encrypted", () => {
    it("shows the switch off and disabled, and says why", async () => {
      await openWorkspace("/?transcripts=unavailable")
      await openPreferences()
      await expect.element(transcriptsSwitch()).toHaveAttribute("aria-checked", "false")
      await expect.element(transcriptsSwitch()).toBeDisabled()
      await expect
        .element(transcriptsSwitch())
        .toHaveAccessibleDescription(/Not available on this computer.*can.t keep a key safe/)
    })
  })

  context("when choosing whether to join ligatures", () => {
    it("draws terminals in the bundled mono without them, then joins them once turned on", async () => {
      await openWorkspace()
      await outputDrawn()
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

/** The Addons tab's voice input card, with its heading. */
const voiceCard = (): Locator => addons().getByRole("region", { name: "Voice input" })

/** The Addons tab's Murmur card, with its heading. */
const murmurCard = (): Locator => addons().getByRole("region", { name: "Murmur" })

describe("Preferences Addons", () => {
  const showAddons = async (): Promise<void> => {
    await openPreferences()
    await tab("Addons").click()
    await expect.element(tab("Addons")).toHaveAttribute("aria-selected", "true")
  }

  context("when voice input is not installed", () => {
    it("offers it with its size, and installs with progress until it is on", async () => {
      await openWorkspace("/?voice=uninstalled")
      await showAddons()

      await expect.element(voiceCard().getByText(/never leaves it/)).toBeVisible()
      await expect.element(voiceCard().getByText(/Downloads 602 MB once/)).toBeVisible()
      // The person never chooses a model.
      await expect.element(voiceCard().getByText("Model", { exact: true })).not.toBeInTheDocument()
      // Off until it is installed, and the install turns it on.
      await expect
        .element(voiceCard().getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "false")
      await expect.element(voiceCard().getByRole("switch", { name: "Enabled" })).toBeDisabled()
      await voiceCard().getByRole("button", { name: "Install" }).click()

      await expect.element(voiceCard().getByText(/Downloading engine/)).toBeVisible()
      await expect.element(voiceCard().getByRole("progressbar")).toBeVisible()
      await expect.element(voiceCard().getByRole("button", { name: "Cancel" })).toBeVisible()
      await expect.element(voiceCard().getByText(/Downloading model/)).toBeVisible()

      const enabled = voiceCard().getByRole("switch", { name: "Enabled" })
      // The demo's install takes a few seconds, its three steps together.
      await expect.element(enabled, { timeout: 10_000 }).toHaveAttribute("aria-checked", "true")
      await expect.element(voiceCard().getByText(/Checked: a test clip took/)).toBeVisible()
      await expect.element(voiceCard().getByText("Model", { exact: true })).not.toBeInTheDocument()
      await expect.element(voiceCard().getByText(/Also install/)).not.toBeInTheDocument()
    })

    it("stops an install on Cancel", async () => {
      // Held at its first step, so Cancel stops it there, however slow the machine.
      await openWorkspace("/?voice=uninstalled&install=held")
      await showAddons()
      await voiceCard().getByRole("button", { name: "Install" }).click()

      await voiceCard().getByRole("button", { name: "Cancel" }).click()

      await expect.element(voiceCard().getByRole("button", { name: "Install" })).toBeVisible()
      await expect.element(voiceCard().getByRole("progressbar")).not.toBeInTheDocument()
    })
  })

  context("when voice input is installed", () => {
    it("turns off, and asks before uninstalling, saying what it frees", async () => {
      // The demo starts it installed and on.
      await openWorkspace()
      await showAddons()
      await expect
        .element(voiceCard().getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "true")

      await voiceCard().getByRole("switch", { name: "Enabled" }).click()
      await expect
        .element(voiceCard().getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "false")

      await voiceCard().getByRole("button", { name: "Uninstall" }).click()
      const confirm = page.getByRole("alertdialog", { name: "Uninstall voice input?" })
      await expect.element(confirm.getByText(/freeing 602 MB/)).toBeVisible()
      await confirm.getByRole("button", { name: "Cancel" }).click()
      await expect.element(confirm).not.toBeInTheDocument()
      await expect.element(voiceCard().getByRole("switch", { name: "Enabled" })).toBeVisible()

      await voiceCard().getByRole("button", { name: "Uninstall" }).click()
      await confirm.getByRole("button", { name: "Uninstall" }).click()
      await expect.element(voiceCard().getByRole("button", { name: "Install" })).toBeVisible()
      // Back to the card before an install: off until the next install turns it on.
      await expect
        .element(voiceCard().getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "false")
    })
  })

  context("when murmur is not installed", () => {
    it("says what it does and installs with progress until it is on", async () => {
      await openWorkspace("/?murmur=uninstalled")
      await showAddons()

      await expect.element(addons().getByText(/Names your terminals/)).toBeVisible()
      await expect
        .element(murmurCard().getByText("Downloads 1.2 GB once, then works offline."))
        .toBeVisible()
      await expect.element(murmurCard().getByText(/GPU/)).not.toBeInTheDocument()
      // Off until it is installed, and the install turns it on.
      await expect
        .element(murmurCard().getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "false")
      await expect.element(murmurCard().getByRole("switch", { name: "Enabled" })).toBeDisabled()
      await murmurCard().getByRole("button", { name: "Install" }).click()

      await expect.element(murmurCard().getByText(/Downloading engine/)).toBeVisible()
      await expect.element(murmurCard().getByRole("progressbar")).toBeVisible()
      await expect.element(murmurCard().getByRole("button", { name: "Cancel" })).toBeVisible()
      await expect.element(murmurCard().getByText(/Downloading model/)).toBeVisible()
      await expect.element(murmurCard().getByText("Checking this computer")).toBeVisible()
      await expect
        .element(murmurCard().getByText("Runs on Intel Arc Graphics."), { timeout: 10_000 })
        .toBeVisible()
      await expect
        .element(murmurCard().getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "true")
    })

    it("stops an install on Cancel", async () => {
      // Held at its first step, so Cancel stops it there, however slow the machine.
      await openWorkspace("/?murmur=uninstalled&install=held")
      await showAddons()
      await murmurCard().getByRole("button", { name: "Install" }).click()

      await murmurCard().getByRole("button", { name: "Cancel" }).click()

      await expect.element(murmurCard().getByRole("button", { name: "Install" })).toBeVisible()
      await expect.element(murmurCard().getByRole("progressbar")).not.toBeInTheDocument()
    })
  })

  context("when this computer can't run murmur", () => {
    it("says Not available in place of Install, with the reason behind Details", async () => {
      await openWorkspace("/?murmur=unsupported")
      await showAddons()

      await expect.element(murmurCard().getByText("Not available on this computer")).toBeVisible()
      await expect
        .element(murmurCard().getByRole("button", { name: "Install" }))
        .not.toBeInTheDocument()
      await expect.element(murmurCard().getByText(/Vulkan driver/)).not.toBeVisible()
      await murmurCard().getByText("Details").click()
      await expect.element(murmurCard().getByText(/Vulkan driver/)).toBeVisible()
    })

    it("checks again from Details, which installs afresh", async () => {
      await openWorkspace("/?murmur=unsupported")
      await showAddons()
      await murmurCard().getByText("Details").click()
      await murmurCard().getByRole("button", { name: "Check again" }).click()

      await expect.element(murmurCard().getByText(/Downloading/)).toBeVisible()
      await expect
        .element(murmurCard().getByText("Runs on Intel Arc Graphics."), { timeout: 10_000 })
        .toBeVisible()
    })

    it("lands there when the install's check finds no device, with no error to try again", async () => {
      await openWorkspace("/?murmur=no-device")
      await showAddons()
      await murmurCard().getByRole("button", { name: "Install" }).click()

      await expect
        .element(murmurCard().getByText("Not available on this computer"), { timeout: 10_000 })
        .toBeVisible()
      await expect
        .element(murmurCard().getByRole("button", { name: "Try again" }))
        .not.toBeInTheDocument()
      await expect.element(murmurCard().getByRole("alert")).not.toBeInTheDocument()
    })
  })

  context("when murmur is installed", () => {
    it("turns off, and asks before uninstalling, saying what it frees", async () => {
      await openWorkspace("/?murmur=uninstalled")
      await showAddons()
      await murmurCard().getByRole("button", { name: "Install" }).click()
      const enabled = murmurCard().getByRole("switch", { name: "Enabled" })
      await expect.element(murmurCard().getByText(/Runs on/), { timeout: 10_000 }).toBeVisible()

      await enabled.click()
      await expect.element(enabled).toHaveAttribute("aria-checked", "false")

      await murmurCard().getByRole("button", { name: "Uninstall" }).click()
      const confirm = page.getByRole("alertdialog", { name: "Uninstall Murmur?" })
      await expect.element(confirm.getByText(/freeing 1\.2 GB/)).toBeVisible()
      await confirm.getByRole("button", { name: "Cancel" }).click()
      await expect.element(confirm).not.toBeInTheDocument()

      await murmurCard().getByRole("button", { name: "Uninstall" }).click()
      await confirm.getByRole("button", { name: "Uninstall" }).click()
      await expect.element(murmurCard().getByRole("button", { name: "Install" })).toBeVisible()
      await expect
        .element(murmurCard().getByRole("switch", { name: "Enabled" }))
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

describe("Shortcut list", () => {
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
      // Chromium reports the real platform; stand in for a Mac so the app picks its bindings.
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

describe("View mode preferences", () => {
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

describe("Terminal text size preference", () => {
  context("when a larger size is chosen", () => {
    it("enlarges terminal text and keeps it after reopening", async () => {
      await openWorkspace()
      await outputDrawn()
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

describe("Appearance preference", () => {
  afterEach(() => systemScheme(null))

  context("when Dark is chosen", () => {
    it("draws the app dark and keeps it after reopening", async () => {
      await systemScheme("light")
      await openWorkspace()
      expect(pageScheme()).toBe("light")
      await openAppearance()

      await chooseMode("Dark")

      await expect.poll(pageScheme).toBe("dark")
      await closePreferences()
      // As a fresh load finds it: nothing on <html> until the app shows what it saved.
      document.documentElement.removeAttribute("data-scheme")
      await reloadWorkspace()
      expect(document.documentElement.dataset).toMatchObject({ theme: "coolant", scheme: "dark" })
      await expect.poll(pageScheme).toBe("dark")
      await openAppearance()
      await expect.element(modeChoice("Dark")).toBeChecked()
    })
  })

  context("when Light is chosen", () => {
    it("stays light while the system is dark", async () => {
      await systemScheme("dark")
      await openWorkspace()
      await expect.poll(pageScheme).toBe("dark")
      await openAppearance()

      await chooseMode("Light")

      await expect.poll(pageScheme).toBe("light")
    })
  })

  context("when a theme with only a dark scheme is chosen", () => {
    it("disables Mode and keeps the page dark while the system is light", async () => {
      await systemScheme("light")
      await openWorkspace()
      await expect.poll(pageScheme).toBe("light")
      await openAppearance()

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

    it("keeps the theme after reloading and gives Coolant its mode back", async () => {
      await systemScheme("light")
      await openWorkspace()
      await openAppearance()
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
      await openAppearance()

      await preferencesDialog().getByRole("combobox", { name: "Theme" }).click()
      await preferencesDialog().getByRole("option", { name: "Coolant" }).click()

      await expect.poll(pageScheme).toBe("light")
      await expect.element(modeChoice("Light")).toBeChecked()
    })
  })

  context("when the saved theme is one the app does not know", () => {
    it("draws and lists Coolant, and keeps the saved id", async () => {
      await systemScheme("light")
      await openWorkspace()
      await openAppearance()

      const saved = JSON.parse(localStorage.getItem("novadeck.preferences") ?? "{}")
      saveFromAnotherWindow("novadeck.preferences", {
        ...saved,
        appearance: { theme: "ember", scheme: "light" },
      })

      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Theme" }))
        .toHaveTextContent("Coolant")
      expect(JSON.parse(localStorage.getItem("novadeck.preferences")!).appearance.theme).toBe(
        "ember",
      )
    })

    it("saves Coolant when the person picks it", async () => {
      await systemScheme("light")
      await openWorkspace()
      await openAppearance()
      const saved = JSON.parse(localStorage.getItem("novadeck.preferences") ?? "{}")
      saveFromAnotherWindow("novadeck.preferences", {
        ...saved,
        appearance: { theme: "ember", scheme: "light" },
      })
      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Theme" }))
        .toHaveTextContent("Coolant")

      await preferencesDialog().getByRole("combobox", { name: "Theme" }).click()
      await preferencesDialog().getByRole("option", { name: "Coolant" }).click()

      await expect
        .poll(() => JSON.parse(localStorage.getItem("novadeck.preferences")!).appearance.theme)
        .toBe("coolant")
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
      await openAppearance()
      await expect.element(modeChoice("System")).toBeChecked()

      const saved = JSON.parse(localStorage.getItem("novadeck.preferences") ?? "{}")
      saveFromAnotherWindow("novadeck.preferences", {
        ...saved,
        appearance: { theme: "coolant", scheme: "dark" },
      })

      await expect.poll(pageScheme).toBe("dark")
      await expect.element(modeChoice("Dark")).toBeChecked()
    })
  })

  context("on the Appearance tab", () => {
    it("holds the theme and the mode, which General no longer does", async () => {
      await openWorkspace()
      await openAppearance()

      const appearance = preferencesDialog().getByRole("tabpanel", { name: "Appearance" })
      await expect
        .element(appearance.getByRole("combobox", { name: "Theme" }))
        .toHaveTextContent("Coolant")
      await expect.element(modeChoice("System")).toBeChecked()
      await tab("General").click()
      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Theme" }))
        .not.toBeInTheDocument()
      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Text size" }))
        .toBeVisible()
    })
  })

  describe("the bell", () => {
    const sound = () => preferencesDialog().getByRole("combobox", { name: "Sound" })
    const savedChoice = () =>
      JSON.parse(localStorage.getItem("novadeck.preferences") ?? "{}").soundChoice

    it("follows the theme until another sound is chosen, which it keeps", async () => {
      await openWorkspace("/?desktop=on")
      await openAppearance()

      await expect.element(sound()).toHaveTextContent("Theme's bell (Felt)")
      await preferencesDialog().getByRole("combobox", { name: "Theme" }).click()
      await preferencesDialog().getByRole("option", { name: "Phosphor Amber" }).click()
      await expect.element(sound()).toHaveTextContent("Theme's bell (Afterglow)")

      await sound().click()
      // The theme's own first, then every sound, by name.
      await expect
        .poll(() =>
          preferencesDialog()
            .getByRole("option")
            .elements()
            .map((option) => option.textContent),
        )
        .toEqual(["Theme's bell (Afterglow)", "Felt", "Afterglow", "Settle", "Beam"])
      await preferencesDialog().getByRole("option", { name: "Beam" }).click()
      await expect.element(sound()).toHaveTextContent("Beam")
      await expect.poll(savedChoice).toBe("beam")
      await closePreferences()
      await openAppearance()
      await expect.element(sound()).toHaveTextContent("Beam")
    })

    it("plays a sound as it is picked", async () => {
      const played: string[] = []
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        played.push(this.src)
        return Promise.resolve()
      }
      try {
        await openWorkspace("/?desktop=on")
        await openAppearance()

        await sound().click()
        await preferencesDialog().getByRole("option", { name: "Settle" }).click()
        await expect.poll(() => played).toHaveLength(1)
        expect(played[0]).toContain("settle")
      } finally {
        HTMLMediaElement.prototype.play = play
      }
    })

    const soundSwitch = () => preferencesDialog().getByRole("switch", { name: "Ring the bell" })

    it("is set where the app shows desktop notifications, its sound and volume only while it rings", async () => {
      await openWorkspace("/?desktop=on")
      await openAppearance()
      const volume = () => preferencesDialog().getByRole("slider", { name: "Volume" })
      const hear = () => preferencesDialog().getByRole("button", { name: "Hear it" })

      await expect.element(soundSwitch()).toBeChecked()
      await expect.element(sound()).toBeVisible()
      await expect.element(hear()).toBeVisible()
      await expect.element(volume()).toBeVisible()
      await soundSwitch().click()
      await expect.element(soundSwitch()).not.toBeChecked()
      await expect.element(sound()).not.toBeInTheDocument()
      await expect.element(hear()).not.toBeInTheDocument()
      await expect.element(volume()).not.toBeInTheDocument()
      await soundSwitch().click()
      await expect.element(volume()).toBeVisible()
    })

    it("keeps the volume it is set to, said as a percentage", async () => {
      await openWorkspace("/?desktop=on")
      await openAppearance()
      const volume = () => preferencesDialog().getByRole("slider", { name: "Volume" })

      await expect.element(volume()).toHaveAttribute("aria-valuetext", "60%")
      await volume().fill("0.3")
      await expect.element(volume()).toHaveAttribute("aria-valuetext", "30%")
      await closePreferences()
      await openAppearance()
      await expect.element(volume()).toHaveValue("0.3")
    })

    it("is left out where the app shows no desktop notifications", async () => {
      await openWorkspace()
      await openPreferences()

      await expect
        .element(
          preferencesDialog().getByRole("switch", { name: "Notify when an agent needs you" }),
        )
        .toBeVisible()
      await expect.element(soundSwitch()).not.toBeInTheDocument()
      await tab("Appearance").click()
      await expect.element(soundSwitch()).not.toBeInTheDocument()
      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Theme" }))
        .toBeVisible()
      await expect
        .element(preferencesDialog().getByRole("combobox", { name: "Sound" }))
        .not.toBeInTheDocument()
    })
  })
})
