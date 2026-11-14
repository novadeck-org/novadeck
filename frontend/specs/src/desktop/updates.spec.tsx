import { onTestFinished } from "vitest"
import { page, type Locator } from "vitest/browser"

import { restartsAsked, setChannelStable } from "../support/backend"
import { closePreferences, openPreferencesOn, preferencesDialog } from "../support/keyboard"
import {
  commandInput,
  draftOf,
  expectStaysAbsent,
  expectTypingIn,
  isMac,
  openWorkspace,
  press,
  sidebar,
  sidebarPanel,
  terminalTab,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

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
  it("is absent where the app does not update", async () => {
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

  context("for an update the app can't install itself", () => {
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

    it("asks for an administrator as Allow updates when the app offers it, then downloads", async () => {
      await openWorkspace("/?update=allow")
      const allow = page.getByRole("button", { name: "Allow updates: Novadeck 0.0.80" })
      await expect.element(allow).toBeVisible()
      expect(allow.element().getAttribute("title")).toContain("administrator's password")
      await allow.click()
      await expect.element(updating()).toBeVisible()
      await expect.element(allow).not.toBeInTheDocument()
    })

    it("shortens to its icon on a narrow bar", async () => {
      await page.viewport(600, 800)
      onTestFinished(() => page.viewport(1440, 900))
      await openWorkspace("/?update=available")
      await expect.element(availableChip()).toBeVisible()
      expect(
        availableChip().element().querySelector("svg")!.getBoundingClientRect().width,
      ).toBeGreaterThan(0)
      await expect
        .element(availableChip().getByText("Update available", { exact: true }))
        .not.toBeVisible()
    })
  })

  context("for an update that is not one to watch download", () => {
    it("shows nothing for one ready at launch", async () => {
      await openWorkspace("/?update=ready")
      await expectStaysAbsent(finished())
      expect(bar()).toBeNull()
      // No chip to fetch it either: the update is downloaded, and has its own chip.
      expect(availableChip().query()).toBeNull()
    })
  })
})

const restartChip = (): Locator =>
  page.getByRole("button", { name: "Restart to update: Novadeck 0.0.80" })

describe("restarting to update", () => {
  it("has no chip where no update is downloaded", async () => {
    await openWorkspace()
    await expectStaysAbsent(restartChip())
  })

  it("has no chip while one downloads", async () => {
    await openWorkspace("/?update=held")
    await expect.element(updating()).toBeVisible()
    expect(restartChip().query()).toBeNull()
  })

  it("leaves a quiet chip once an update is downloaded, which opens its card and restarts on a press", async () => {
    await openWorkspace("/?update=ready")
    await expect.element(restartChip()).toBeVisible()
    expect(page.getByText("Restart · 0.0.80").query()).toBeNull()
    const before = restartsAsked()
    await restartChip().click()
    await expect.element(page.getByText("Restart · 0.0.80")).toBeVisible()
    await page.getByRole("button", { name: "Restart now" }).click()
    await expect.element(page.getByRole("button", { name: "Restarting…" })).toBeDisabled()
    expect(restartsAsked()).toBe(before + 1)
  })
})

// The About tab holds the Experimental switch.
const experimental = () => preferencesDialog().getByRole("switch", { name: "Experimental" })
const experimentalTab = () => preferencesDialog().getByRole("tab", { name: "Experimental" })

describe("the Experimental switch in Preferences", () => {
  it("is absent where the app has no updates, and so is its tab", async () => {
    await openWorkspace()
    await openPreferencesOn("About")
    await expect
      .element(preferencesDialog().getByRole("heading", { name: "Updates" }))
      .not.toBeInTheDocument()
    expect(experimental().query()).toBeNull()
    expect(experimentalTab().query()).toBeNull()
  })

  it("starts off, and stays on once turned on, also when Preferences opens again", async () => {
    await openWorkspace("/?update=ready")
    await openPreferencesOn("About")
    await expect.element(experimental()).toBeEnabled()
    await expect.element(experimental()).toHaveAttribute("aria-checked", "false")
    await experimental().click()
    await expect.element(experimental()).toHaveAttribute("aria-checked", "true")
    await closePreferences()
    await openPreferencesOn("About")
    await expect.element(experimental()).toHaveAttribute("aria-checked", "true")
    await experimental().click()
    await expect.element(experimental()).toHaveAttribute("aria-checked", "false")
  })

  it("shows the Experimental tab, with the chat view, while it is on", async () => {
    await openWorkspace("/?update=ready")
    await openPreferencesOn("About")
    expect(experimentalTab().query()).toBeNull()
    await experimental().click()
    await experimentalTab().click()
    await expect
      .element(preferencesDialog().getByRole("switch", { name: "Chat view" }))
      .toBeVisible()
    await preferencesDialog().getByRole("tab", { name: "About" }).click()
    await experimental().click()
    await expect.element(experimentalTab()).not.toBeInTheDocument()
  })

  it("turns agent worktrees off with it, so they never stay on without their toggle", async () => {
    const worktrees = () =>
      preferencesDialog().getByRole("switch", { name: "Agent worktrees and Changes" })
    await openWorkspace("/?update=ready")
    await openPreferencesOn("About")
    await experimental().click()
    await experimentalTab().click()
    await expect.element(worktrees()).toHaveAttribute("aria-checked", "false")
    await worktrees().click()
    await expect.element(worktrees()).toHaveAttribute("aria-checked", "true")
    await preferencesDialog().getByRole("tab", { name: "About" }).click()
    await experimental().click()
    await experimental().click()
    await experimentalTab().click()
    await expect.element(worktrees()).toHaveAttribute("aria-checked", "false")
  })

  it("shows the Changes panel only while agent worktrees are on", async () => {
    const worktrees = () =>
      preferencesDialog().getByRole("switch", { name: "Agent worktrees and Changes" })
    // A stable launch turns agent worktrees off, so a link to the Changes panel opens Terminals.
    await openWorkspace("/projects/storefront/sessions/initial/focus?update=ready&panel=changes")
    await expect.element(sidebar()).toHaveAccessibleName("Terminal sessions")
    await expectStaysAbsent(sidebarPanel("Changes"))
    await openPreferencesOn("About")
    await experimental().click()
    await experimentalTab().click()
    await worktrees().click()
    await closePreferences()
    await expect.element(sidebarPanel("Changes")).toBeVisible()
    await sidebarPanel("Changes").click()
    await expect.element(sidebar()).toHaveAccessibleName("Changes")
    // Turning them off again, with Changes open, takes the panel away and goes back to Terminals.
    await openPreferencesOn("About")
    await experimental().click()
    await closePreferences()
    await expect.element(sidebarPanel("Changes")).not.toBeInTheDocument()
    await expect.element(sidebar()).toHaveAccessibleName("Terminal sessions")
  })

  it("forgets a step back to the Changes panel once it is gone", async () => {
    await openWorkspace("/?update=ready")
    await openPreferencesOn("About")
    await experimental().click()
    await experimentalTab().click()
    await preferencesDialog().getByRole("switch", { name: "Agent worktrees and Changes" }).click()
    await closePreferences()
    await sidebarPanel("Changes").click()
    await sidebarPanel("Inbox").click()
    await expect.element(sidebar()).toHaveAccessibleName("Inbox")
    await openPreferencesOn("About")
    await experimental().click()
    await closePreferences()
    await expect.element(sidebarPanel("Changes")).not.toBeInTheDocument()
    // The Inbox's toggle, with no Changes to go back to, hides the sidebar.
    await sidebarPanel("Inbox").click()
    await expect.element(sidebar()).not.toBeInTheDocument()
  })

  it("turns agent worktrees off when Preferences opens again and the channel reads stable", async () => {
    const worktrees = () =>
      preferencesDialog().getByRole("switch", { name: "Agent worktrees and Changes" })
    await openWorkspace("/?update=ready")
    await openPreferencesOn("About")
    await experimental().click()
    await experimentalTab().click()
    await worktrees().click()
    await expect.element(worktrees()).toHaveAttribute("aria-checked", "true")
    await closePreferences()
    setChannelStable()
    await openPreferencesOn("About")
    await expect.element(experimental()).toHaveAttribute("aria-checked", "false")
    await expect.element(experimentalTab()).not.toBeInTheDocument()
    await experimental().click()
    await experimentalTab().click()
    await expect.element(worktrees()).toHaveAttribute("aria-checked", "false")
  })
})
