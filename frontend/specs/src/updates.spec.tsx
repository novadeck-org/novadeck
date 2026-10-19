import { describe as context, describe, expect, it } from "vitest"
import { page, type Locator } from "vitest/browser"

import { preferencesDialog } from "./support/keyboard"
import {
  commandInput,
  draftOf,
  expectStaysAbsent,
  expectTypingIn,
  isMac,
  openWorkspace,
  press,
  terminalTab,
} from "./support/workspace"

// The floating bar is aria-hidden, so it is found by its words, not its role.
const title = (text: string): Locator => page.getByText(text, { exact: true })
const updating = () => title("Updating Novadeck")
const finished = () => title("Update ready")
const bar = (): Element | null => document.querySelector(".update-progress")
const percent = () => page.getByText(/^\d+%$/)
const announcer = () => page.getByRole("status").filter({ hasText: /Novadeck update/ })
// A demo download takes 3 seconds to finish, then the bar stays 4 more before it fades.
const slow = { timeout: 10_000 }
const typing = () => commandInput("Checkout review")

// Closing the window doesn't quit the app on macOS, so there an update installs on a quit.
const installsWhen = isMac() ? "when you quit Novadeck" : "on the next restart"

const availableChip = (): Locator =>
  page.getByRole("button", { name: "Update available: Novadeck 0.0.80" })

describe("the update progress bar", () => {
  it("is absent where the host does not update", async () => {
    await openWorkspace()
    await expectStaysAbsent(updating())
    expect(bar()).toBeNull()
  })

  context("for an update being downloaded", () => {
    it("shows the percent with nothing to press, and no chip in the footer", async () => {
      await openWorkspace("/?update=download")
      await expect.element(updating()).toBeVisible()
      await expect.element(title("Downloading 0.0.80")).toBeVisible()
      await expect.element(percent()).toBeVisible()
      expect(bar()?.querySelector("button, a, input")).toBeNull()
      expect(bar()?.getAttribute("aria-hidden")).toBe("true")
      expect(page.getByRole("button", { name: /update/i }).query()).toBeNull()
      await expect.element(announcer()).toHaveTextContent("Downloading Novadeck update")
    })

    it("says the update is ready when the download ends, then goes away", async () => {
      await openWorkspace("/?update=download")
      await expect.element(finished(), slow).toBeVisible()
      await expect.element(title("100%")).toBeVisible()
      await expect.element(title(`0.0.80 installs ${installsWhen}`)).toBeVisible()
      await expect
        .element(announcer())
        .toHaveTextContent(`Novadeck update downloaded, installs ${installsWhen}`)
      await expect.element(finished(), slow).not.toBeInTheDocument()
      expect(bar()).toBeNull()
    })

    it("never takes the keyboard's focus, so typing still reaches the terminal", async () => {
      await openWorkspace("/?update=download")
      await expect.element(updating()).toBeVisible()
      await terminalTab("Checkout review").click()
      await expect.element(typing()).toHaveFocus()
      expect(bar()?.contains(document.activeElement) ?? false).toBe(false)
      await press("echo hi")
      await expect.poll(() => draftOf("Checkout review")).toBe("echo hi")
      await expectTypingIn("Checkout review")
    })

    it("lets clicks through to what is under it", async () => {
      await openWorkspace("/?update=download")
      await expect.element(updating()).toBeVisible()
      expect(getComputedStyle(bar()!).pointerEvents).toBe("none")
    })

    it("waits for Zen mode to end with the footer", async () => {
      await openWorkspace("/?update=download")
      await expect.element(updating()).toBeVisible()
      await page.getByRole("button", { name: "Enter Zen mode" }).click()
      await expect.element(updating()).not.toBeInTheDocument()
      expect(bar()).toBeNull()
    })
  })

  context("for an update the host can't install itself", () => {
    it("shows a quiet chip instead, with no bar, panel or dialog", async () => {
      await openWorkspace("/?update=available")
      await expect.element(availableChip()).toBeVisible()
      expect(availableChip().element().hasAttribute("aria-expanded")).toBe(false)
      expect(bar()).toBeNull()
      expect(page.getByRole("region", { name: /Novadeck 0\.0\.80/ }).query()).toBeNull()
    })

    it("opens the release page on a press, and stays", async () => {
      await openWorkspace("/?update=available")
      await availableChip().click()
      await expect.element(availableChip()).toBeVisible()
      expect(page.getByRole("dialog").query()).toBeNull()
      expect(page.getByRole("region", { name: /Novadeck 0\.0\.80/ }).query()).toBeNull()
    })

    it("asks for an administrator as Allow updates when the host offers it, then downloads", async () => {
      await openWorkspace("/?update=allow")
      const allow = page.getByRole("button", { name: "Allow updates: Novadeck 0.0.80" })
      await expect.element(allow).toBeVisible()
      expect(allow.element().getAttribute("title")).toContain("administrator's password")
      await allow.click()
      await expect.element(updating()).toBeVisible()
      await expect.element(allow).not.toBeInTheDocument()
    })

    it("shortens to Update on a narrow bar", async () => {
      await page.viewport(600, 800)
      try {
        await openWorkspace("/?update=available")
        await expect.element(availableChip().getByText("Update", { exact: true })).toBeVisible()
      } finally {
        await page.viewport(1440, 900)
      }
    })
  })

  context("for an update that is not one to watch download", () => {
    it("shows nothing for one ready at launch", async () => {
      await openWorkspace("/?update=ready")
      await expectStaysAbsent(finished())
      expect(bar()).toBeNull()
      expect(page.getByRole("button", { name: /update/i }).query()).toBeNull()
    })
  })
})

const openPreferences = async (): Promise<void> => {
  await page.getByRole("button", { name: "Workspace preferences" }).click()
  await expect.element(preferencesDialog()).toBeVisible()
}
const early = () => preferencesDialog().getByRole("switch", { name: "Early builds" })

describe("Preferences' early builds", () => {
  it("is absent where the host has no updates", async () => {
    await openWorkspace()
    await openPreferences()
    await expect
      .element(preferencesDialog().getByRole("heading", { name: "Updates" }))
      .not.toBeInTheDocument()
    expect(early().query()).toBeNull()
  })

  it("starts off, and stays on once turned on, also when Preferences opens again", async () => {
    await openWorkspace("/?update=ready")
    await openPreferences()
    await expect.element(early()).toBeEnabled()
    await expect.element(early()).toHaveAttribute("aria-checked", "false")
    await early().click()
    await expect.element(early()).toHaveAttribute("aria-checked", "true")
    await preferencesDialog().getByRole("button", { name: "Close preferences" }).click()
    await expect.element(preferencesDialog()).not.toBeInTheDocument()
    await openPreferences()
    await expect.element(early()).toHaveAttribute("aria-checked", "true")
    await early().click()
    await expect.element(early()).toHaveAttribute("aria-checked", "false")
  })
})
