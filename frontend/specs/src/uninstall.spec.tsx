import { describe as context, describe, expect, it, vi } from "vitest"
import { page, type Locator } from "vitest/browser"

import { expectFocusWithin, preferencesDialog } from "./support/keyboard"
import { expectStaysAbsent, openWorkspace } from "./support/workspace"

const openPreferences = async (): Promise<void> => {
  await page.getByRole("button", { name: "Workspace preferences" }).click()
  await expectFocusWithin(preferencesDialog())
}

const about = (): Locator => preferencesDialog().getByRole("region", { name: "About" })
const row = (): Locator => about().getByRole("button", { name: "Uninstall…" })
const dialog = (): Locator => page.getByRole("alertdialog")
const slow = { timeout: 6000 }

describe("Preferences' Uninstall Novadeck", () => {
  context("where the host offers none or nothing", () => {
    it.each([["/"], ["/?uninstall=unavailable"]])("is absent on %s", async (route) => {
      await openWorkspace(route)
      await openPreferences()
      await expect.element(about().getByText("Version")).toBeVisible()
      await expectStaysAbsent(row())
      expect(about().getByText("Uninstall Novadeck").query()).toBeNull()
    })
  })

  context("for a copy a package manager installed", () => {
    it("gives the command to copy, with no way to uninstall from here", async () => {
      await openWorkspace("/?uninstall=manual")
      await openPreferences()
      await expect.element(about().getByText(/Homebrew installed Novadeck/)).toBeVisible()
      await expect.element(about().getByText("brew uninstall --cask novadeck")).toBeVisible()
      vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
      await about().getByRole("button", { name: "Copy" }).click()
      await expect.element(about().getByRole("button", { name: "Copied" })).toBeVisible()
      expect(row().query()).toBeNull()
    })
  })

  context("for a copy the app removes", () => {
    it("asks first, keeping data by default, and cancels without a trace", async () => {
      await openWorkspace("/?uninstall=removed")
      await openPreferences()
      await expect.element(about().getByText("Removes the app from this computer.")).toBeVisible()
      await row().click()
      await expect.element(dialog().getByText("Uninstall Novadeck?")).toBeVisible()
      await expect.element(dialog().getByText(/Running terminals will end/)).toBeVisible()
      await expect
        .element(dialog().getByRole("checkbox", { name: "Keep my projects and sessions" }))
        .toBeChecked()
      await expect.element(dialog().getByText("/home/mzpk/Novadeck")).toBeVisible()
      await expect.element(dialog().getByRole("button", { name: "Cancel" })).toHaveFocus()
      await dialog().getByRole("button", { name: "Cancel" }).click()
      await expect.element(dialog()).not.toBeInTheDocument()
    })

    it("disconnects the connected agents, shows Removing…, then offers Quit", async () => {
      await openWorkspace("/?uninstall=removed")
      await openPreferences()
      const claude = preferencesDialog().getByRole("switch", { name: "Claude Code" })
      await claude.click()
      await expect.element(claude, slow).toHaveAttribute("aria-checked", "true")
      await row().click()
      await expect.element(dialog().getByText(/disconnected from Claude Code\./)).toBeVisible()
      await dialog().getByRole("button", { name: "Uninstall", exact: true }).click()
      await expect.element(dialog().getByRole("button", { name: "Removing…" })).toBeDisabled()
      await expect.element(dialog().getByText("Novadeck is uninstalled."), slow).toBeVisible()
      await expect.element(dialog().getByRole("button", { name: "Quit" })).toHaveFocus()
    })

    it("has no data choice where the host has no data folder", async () => {
      await openWorkspace("/?uninstall=no-data")
      await openPreferences()
      await row().click()
      await expect.element(dialog().getByText("Uninstall Novadeck?")).toBeVisible()
      expect(dialog().getByRole("checkbox").query()).toBeNull()
    })

    it("keeps the dialog open with the reason when the removal fails", async () => {
      await openWorkspace("/?uninstall=failed")
      await openPreferences()
      await row().click()
      await dialog().getByRole("button", { name: "Uninstall", exact: true }).click()
      await expect
        .element(dialog().getByRole("alert"), slow)
        .toHaveTextContent("Novadeck is in a folder you can't change.")
      await expect
        .element(dialog().getByRole("button", { name: "Uninstall", exact: true }))
        .toBeEnabled()
    })

    it("keeps the advice of a failure after the terminals ended, on every retry", async () => {
      await openWorkspace("/?uninstall=stopped")
      await openPreferences()
      await row().click()
      const retry = async (): Promise<void> => {
        await dialog().getByRole("button", { name: "Uninstall", exact: true }).click()
        await expect
          .poll(() => dialog().getByRole("alert").element().textContent, slow)
          .toMatch(/quit it and open it again\.$/)
      }
      await retry()
      await retry()
    })

    it("lets a Trash refusal succeed on the second try", async () => {
      await openWorkspace("/?uninstall=trash")
      await openPreferences()
      await row().click()
      await dialog().getByRole("button", { name: "Uninstall", exact: true }).click()
      await expect
        .poll(() => dialog().getByRole("alert").element().textContent, slow)
        .toMatch(/App Management/)
      await dialog().getByRole("button", { name: "Uninstall", exact: true }).click()
      await expect.element(dialog().getByText("Novadeck is uninstalled."), slow).toBeVisible()
    })

    it("hands over to the platform's uninstaller, which finishes the job", async () => {
      await openWorkspace("/?uninstall=windows")
      await openPreferences()
      await row().click()
      await expect
        .element(dialog().getByText(/Windows' uninstaller finishes the job/))
        .toBeVisible()
      await dialog().getByRole("button", { name: "Continue" }).click()
      await expect
        .element(dialog().getByText("Novadeck is closing for its uninstaller."), slow)
        .toBeVisible()
      expect(dialog().element().querySelectorAll("button")).toHaveLength(0)
    })

    it("gives the leftover command to copy before Quit", async () => {
      await openWorkspace("/?uninstall=leftover")
      await openPreferences()
      await row().click()
      await dialog().getByRole("button", { name: "Uninstall", exact: true }).click()
      await expect
        .element(dialog().getByText("sudo rm /etc/apparmor.d/novadeck"), slow)
        .toBeVisible()
      await expect.element(dialog().getByRole("button", { name: "Copy" })).toBeVisible()
    })
  })
})
