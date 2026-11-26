import { onTestFinished } from "vitest"
import { cleanup } from "vitest-browser-react"
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

  it("opens its card from the chip while the finished download's bar still shows", async () => {
    await openWorkspace("/?update=download")
    await expect.element(finished(), slow).toBeVisible()
    await restartChip().click()
    await expect.element(page.getByText("Restart · 0.0.80")).toBeVisible()
    expect(bar()).toBeNull()
    await expect.element(page.getByRole("button", { name: "Restart now" })).toBeEnabled()
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

// The About tab holds the Experimental switch, hidden while off until the version is tapped ten
// times; once shown it stays for the rest of the run.
const experimental = () => preferencesDialog().getByRole("switch", { name: "Experimental" })
const experimentalTab = () => preferencesDialog().getByRole("tab", { name: "Experimental" })
const tapVersion = async (times: number): Promise<void> => {
  const version = preferencesDialog().getByText("0.0.79", { exact: true })
  // eslint-disable-next-line no-await-in-loop -- Each tap after the one before.
  for (let at = 0; at < times; at += 1) await version.click()
}
// Opens About and taps the version until the Experimental switch shows.
const openExperimental = async (): Promise<void> => {
  await openPreferencesOn("About")
  await tapVersion(10)
  await expect.element(experimental()).toBeVisible()
}

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

  it("is hidden while off, until the version is tapped ten times, counting the last taps down", async () => {
    await openWorkspace("/?update=ready")
    await openPreferencesOn("About")
    await expect.element(preferencesDialog().getByText("0.0.79", { exact: true })).toBeVisible()
    expect(experimental().query()).toBeNull()
    await tapVersion(5)
    await expect
      .element(preferencesDialog().getByText("Tap 5 more times to show Experimental"))
      .toBeVisible()
    expect(experimental().query()).toBeNull()
    await tapVersion(5)
    await expect.element(experimental()).toHaveAttribute("aria-checked", "false")
    expect(
      preferencesDialog().getByText("to show Experimental", { exact: false }).query(),
    ).toBeNull()
  })

  it("stays in sight, turned off, until the next launch, and hides then", async () => {
    await openWorkspace("/?update=ready")
    await openExperimental()
    await experimental().click()
    await expect.element(experimental()).toHaveAttribute("aria-checked", "true")
    await experimental().click()
    await expect.element(experimental()).toHaveAttribute("aria-checked", "false")
    await closePreferences()
    await openPreferencesOn("About")
    await expect.element(experimental()).toHaveAttribute("aria-checked", "false")
    await closePreferences()
    // A launch: in-memory state starts over, the stored channel stays.
    await cleanup()
    await openWorkspace("/?update=ready")
    await openPreferencesOn("About")
    await expect.element(preferencesDialog().getByText("0.0.79", { exact: true })).toBeVisible()
    expect(experimental().query()).toBeNull()
  })

  it("shows without taps where it is on, and stays for the run once the channel goes off elsewhere", async () => {
    await openWorkspace("/?update=ready&channel=experimental")
    await openPreferencesOn("About")
    await expect.element(experimental()).toHaveAttribute("aria-checked", "true")
    await closePreferences()
    // As another window, or the debug panel, turning it off.
    setChannelStable()
    await openPreferencesOn("About")
    await expect.element(experimental()).toHaveAttribute("aria-checked", "false")
  })

  it("starts off, and stays on once turned on, also when Preferences opens again", async () => {
    await openWorkspace("/?update=ready")
    await openExperimental()
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

  it("shows the Experimental tab, with agent avatars, while it is on", async () => {
    await openWorkspace("/?update=ready")
    await openExperimental()
    expect(experimentalTab().query()).toBeNull()
    await experimental().click()
    await experimentalTab().click()
    await expect
      .element(preferencesDialog().getByRole("switch", { name: "Agent avatars" }))
      .toBeVisible()
    await preferencesDialog().getByRole("tab", { name: "About" }).click()
    await experimental().click()
    await expect.element(experimentalTab()).not.toBeInTheDocument()
  })

  it("leaves agent worktrees on through a stable launch and the switch going off", async () => {
    const worktrees = () => preferencesDialog().getByRole("switch", { name: "Agent worktrees" })
    // A stable launch leaves them on, so a link to the Worktrees panel opens it.
    await openWorkspace("/projects/storefront/sessions/initial/focus?update=ready&panel=worktrees")
    await expect.element(sidebar()).toHaveAccessibleName("Worktrees")
    await openExperimental()
    await experimental().click()
    await experimental().click()
    await expect.element(experimental()).toHaveAttribute("aria-checked", "false")
    await preferencesDialog().getByRole("tab", { name: "Agents" }).click()
    await expect.element(worktrees()).toHaveAttribute("aria-checked", "true")
    await closePreferences()
    setChannelStable()
    await openPreferencesOn("Agents")
    await expect.element(worktrees()).toHaveAttribute("aria-checked", "true")
    await closePreferences()
    await expect.element(sidebarPanel("Worktrees")).toBeVisible()
  })
})
