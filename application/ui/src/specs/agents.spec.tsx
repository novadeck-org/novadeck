import { describe as context, describe, expect, it } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { expectFocusWithin, preferencesDialog } from "./support/keyboard"
import { expectStaysAbsent, openWorkspace } from "./support/workspace"

const agentSwitch = (scope: Locator, name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  scope.getByRole("switch", { name })

const agentChoice = (scope: Locator, name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  scope.getByRole("checkbox", { name })

const welcome = (): Locator => page.getByRole("dialog", { name: "Welcome to NovaDeck" })

const openPreferences = async (): Promise<void> => {
  await page.getByRole("button", { name: "Workspace preferences" }).click()
  await expectFocusWithin(preferencesDialog())
}

describe("An agent waiting on the person", () => {
  it("says so on its terminal's tab and window", async () => {
    // The demo's Codex waits for permission to run a command.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const tab = page.getByRole("button", { name: "Select Checkout review" })
    await expect.element(tab).toHaveAttribute("aria-description", "Needs permission")
    await tab.click()
    await expect
      .element(page.getByRole("region", { name: "Checkout review terminal" }))
      .toHaveAttribute("aria-description", "Needs permission")
  })
})

describe("Connecting agents", () => {
  context("in Preferences", () => {
    it("offers each installed agent switched off, and not the ones missing", async () => {
      await openWorkspace()
      await openPreferences()
      const dialog = preferencesDialog()
      await expect
        .element(agentSwitch(dialog, "Claude Code"))
        .toHaveAttribute("aria-checked", "false")
      await expect.element(agentSwitch(dialog, "Codex")).toBeEnabled()
      await expect.element(agentSwitch(dialog, "Antigravity")).toBeDisabled()
      await expect
        .element(agentSwitch(dialog, "Antigravity"))
        .toHaveAccessibleDescription("Not installed")
    })

    it("connects and disconnects an agent", async () => {
      await openWorkspace()
      await openPreferences()
      const claude = agentSwitch(preferencesDialog(), "Claude Code")
      await claude.click()
      await expect.element(claude).toHaveAttribute("aria-checked", "true")
      // The switch speaks for itself; a connected agent needs no note.
      await expect.element(claude).not.toHaveAccessibleDescription()
      await claude.click()
      await expect.element(claude).toHaveAttribute("aria-checked", "false")
    })
  })

  context("when the app opens for the first time", () => {
    it("previews each layout without leaving the welcome dialog or connecting agents", async () => {
      await openWorkspace("/?demo=welcome")
      const dialog = welcome()
      await expect
        .element(dialog.getByRole("heading", { name: "Big ideas. Room to build." }))
        .toHaveFocus()
      await userEvent.keyboard("{Tab}{Enter}")
      await expect
        .element(dialog.getByRole("button", { name: "Focus", exact: true }))
        .toHaveAttribute("aria-pressed", "true")
      await expect.element(dialog.getByText("One terminal, full attention.")).toBeVisible()
      await dialog.getByRole("button", { name: "Grid", exact: true }).click()
      await expect.element(dialog.getByText("Everything side by side.")).toBeVisible()
      await dialog.getByRole("button", { name: "Canvas", exact: true }).click()
      await expect.element(dialog.getByText("Spread out on a zoomable canvas.")).toBeVisible()
      await expect.element(agentChoice(dialog, "Claude Code")).toBeChecked()
      await expect.element(agentChoice(dialog, "Antigravity")).toBeDisabled()
    })

    it("chooses every installed agent, connects the chosen ones, and does not ask again", async () => {
      await openWorkspace("/?demo=welcome")
      await expect.element(welcome()).toBeVisible()
      await expect.element(agentChoice(welcome(), "Claude Code")).toBeChecked()
      await expect.element(agentChoice(welcome(), "Codex")).toBeChecked()
      await expect.element(agentChoice(welcome(), "Antigravity")).not.toBeChecked()
      await agentChoice(welcome(), "Codex").click()
      await welcome().getByRole("button", { name: "Let’s build something" }).click()
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(agentSwitch(preferencesDialog(), "Claude Code"))
        .toHaveAttribute("aria-checked", "true")
      await expect
        .element(agentSwitch(preferencesDialog(), "Codex"))
        .toHaveAttribute("aria-checked", "false")
    })

    it("discards its choices when dismissed", async () => {
      await openWorkspace("/?demo=welcome")
      await expect.element(welcome()).toBeVisible()
      await expect.element(agentChoice(welcome(), "Codex")).toBeChecked()
      await userEvent.keyboard("{Escape}")
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(agentSwitch(preferencesDialog(), "Codex"))
        .toHaveAttribute("aria-checked", "false")
    })

    it("skips setup without connecting selected agents", async () => {
      await openWorkspace("/?demo=welcome")
      await expect.element(agentChoice(welcome(), "Claude Code")).toBeChecked()
      await welcome().getByRole("button", { name: "Skip for now" }).click()
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(agentSwitch(preferencesDialog(), "Claude Code"))
        .toHaveAttribute("aria-checked", "false")
    })

    it("keeps transcripts on unless turned off and started", async () => {
      await openWorkspace("/?demo=welcome")
      const choice = welcome().getByRole("checkbox", { name: "Transcripts" })
      await expect.element(choice).toBeChecked()
      await expect.element(choice).toHaveAccessibleDescription(/secrets/)
      await choice.click()
      await welcome().getByRole("button", { name: "Let’s build something" }).click()
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(preferencesDialog().getByRole("switch", { name: "Transcripts" }))
        .toHaveAttribute("aria-checked", "false")
    })

    it("leaves transcripts as they were when skipped", async () => {
      await openWorkspace("/?demo=welcome")
      await welcome().getByRole("checkbox", { name: "Transcripts" }).click()
      await welcome().getByRole("button", { name: "Skip for now" }).click()
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(preferencesDialog().getByRole("switch", { name: "Transcripts" }))
        .toHaveAttribute("aria-checked", "true")
    })
  })

  it("is not offered at startup once the person has seen it", async () => {
    await openWorkspace()
    await expectStaysAbsent(welcome())
    expect(welcome().query()).toBeNull()
  })
})
