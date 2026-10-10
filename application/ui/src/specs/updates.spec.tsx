import { afterEach, describe as context, describe, expect, it } from "vitest"
import { cleanup } from "vitest-browser-react"
import { page, type Locator } from "vitest/browser"

import { boxOf, doubleClickHeader, fillsView, sameBox } from "./support/canvas"
import { findDialog, pressShortcut, preferencesDialog, recentSwitcher } from "./support/keyboard"
import {
  commandInput,
  enterNavigateMode,
  expectStaysAbsent,
  expectTypingIn,
  chooseView,
  focusStage,
  navigateChip,
  openWorkspace,
  press,
  terminal,
  terminalTab,
} from "./support/workspace"

// The version whose notice came up last, as the app keeps it between launches.
const seenKey = "novadeck.update-seen"

const chip = (name: RegExp = /^Update (ready|available):/): Locator =>
  page.getByRole("button", { name })
const popover = (title: string): Locator => page.getByRole("region", { name: title })
const ready = () => popover("Novadeck 0.0.80 is ready")
const available = () => popover("Novadeck 0.0.80 is available")
const restart = () => ready().getByRole("button", { name: "Restart now" })
const typing = () => commandInput("Dev server")
const pill = () => page.getByRole("group", { name: "Subscriptions" }).getByRole("button").first()
const checkout = () => boxOf(terminal("Checkout implementation"))
const later = (dialog: Locator) => dialog.getByRole("button", { name: "Later" })

describe("the update notice", () => {
  afterEach(() => page.viewport(1440, 900))

  it("is absent where the host does not update", async () => {
    await openWorkspace()
    await expectStaysAbsent(chip())
    expect(chip().query()).toBeNull()
  })

  context("for a downloaded update", () => {
    it("comes up over the footer's chip with the notes and its actions", async () => {
      await openWorkspace("/?demo=update")
      await expect.element(ready()).toBeVisible()
      await expect
        .element(ready().getByText("Terminals keep their place when you switch projects."))
        .toBeVisible()
      await expect.element(ready().getByRole("button", { name: "Release notes" })).toBeVisible()
      await expect.element(restart()).toBeVisible()
      await expect.element(later(ready())).toBeVisible()
      await expect
        .element(page.getByRole("status").filter({ hasText: "Update ready" }))
        .toBeInTheDocument()
      await expect.element(chip(/^Update ready: Novadeck 0.0.80$/)).toBeVisible()
    })

    it("shows Restarting in the footer once Restart now is pressed, and does nothing more", async () => {
      await openWorkspace("/?demo=update")
      await restart().click()
      await expect.element(ready()).not.toBeInTheDocument()
      const restarting = chip(/^Update ready:/)
      await expect.element(restarting).toBeDisabled()
      await expect.element(restarting).toHaveTextContent("Restarting…")
    })

    it("keeps the chip after Later and opens the popover again from it", async () => {
      await openWorkspace("/?demo=update")
      await later(ready()).click()
      await expect.element(ready()).not.toBeInTheDocument()
      await expect.element(chip()).toBeVisible()
      await chip().click()
      await expect.element(ready()).toBeVisible()
    })

    it("closes on Escape from inside it", async () => {
      await openWorkspace("/?demo=update")
      ready().getByRole("button", { name: "Later" }).element().focus()
      await press("{Escape}")
      await expect.element(ready()).not.toBeInTheDocument()
    })

    it("keeps the narrow bar's chip as Update alone", async () => {
      await page.viewport(600, 800)
      await openWorkspace("/?demo=update")
      await later(ready()).click()
      await expect.element(chip().getByText("Update", { exact: true })).toBeVisible()
      await expect.element(chip().getByText("Update ready", { exact: true })).not.toBeVisible()
    })
  })

  context("for an update the host can't install itself", () => {
    it("offers Download rather than Restart, and the chip says available", async () => {
      await openWorkspace("/?demo=update-available")
      await expect.element(available()).toBeVisible()
      await expect.element(available().getByRole("button", { name: "Download" })).toBeVisible()
      await expect
        .element(available().getByRole("button", { name: "Restart now" }))
        .not.toBeInTheDocument()
      await expect.element(later(available())).toBeVisible()
      await later(available()).click()
      await expect.element(chip(/^Update available: Novadeck 0.0.80$/)).toBeVisible()
    })

    it("closes after Download", async () => {
      await openWorkspace("/?demo=update-available")
      await available().getByRole("button", { name: "Download" }).click()
      await expect.element(available()).not.toBeInTheDocument()
    })
  })

  context("once per version", () => {
    it("does not come up again on a relaunch of the version it came up for", async () => {
      await openWorkspace("/?demo=update")
      await expect.element(ready()).toBeVisible()
      // The next launch: the same version is offered again.
      await cleanup()
      await openWorkspace("/?demo=update")
      await expect.element(chip()).toBeVisible()
      await expectStaysAbsent(ready())
    })

    it("comes up for a version newer than the last it showed", async () => {
      localStorage.setItem(seenKey, "ready:0.0.79")
      await openWorkspace("/?demo=update")
      await expect.element(ready()).toBeVisible()
      expect(localStorage.getItem(seenKey)).toBe("ready:0.0.80")
    })

    it("comes up again when the version shown before is now one to download", async () => {
      localStorage.setItem(seenKey, "ready:0.0.80")
      await openWorkspace("/?demo=update-available")
      await expect.element(available()).toBeVisible()
    })

    it("does not come up for a version that was shown before", async () => {
      localStorage.setItem(seenKey, "ready:0.0.80")
      await openWorkspace("/?demo=update")
      await expect.element(chip()).toBeVisible()
      await expectStaysAbsent(ready())
    })
  })

  context("while the footer is hidden", () => {
    it("waits for Zen mode to end, and is still there for the person to answer", async () => {
      await openWorkspace("/?demo=update")
      await expect.element(ready()).toBeVisible()
      await page.getByRole("button", { name: "Enter Zen mode" }).click()
      await expect.element(ready()).not.toBeInTheDocument()
      const dock = page.getByRole("group", { name: "Zen controls" })
      await dock.getByRole("button", { name: "Show Zen controls" }).click()
      await dock.getByRole("button", { name: "Exit Zen" }).click()
      await expect.element(ready()).toBeVisible()
    })
  })

  context("while the notice is up and the person works", () => {
    const noticeUp = async (): Promise<void> => {
      await openWorkspace("/?demo=update")
      await expect.element(ready()).toBeVisible()
      await terminalTab("Dev server").click()
      await expect.element(typing()).toHaveFocus()
    }

    it("never takes the keyboard's focus when it comes up", async () => {
      await openWorkspace("/?demo=update")
      await expect.element(ready()).toBeVisible()
      expect(ready().element().contains(document.activeElement)).toBe(false)
    })

    it("is no dialog, so Preferences and the like see no overlay", async () => {
      await openWorkspace("/?demo=update")
      await expect.element(ready()).toBeVisible()
      expect(page.getByRole("dialog").query()).toBeNull()
    })

    it("lets typed keys reach the terminal, and stays up", async () => {
      await noticeUp()
      await press("echo hi")
      await expect.element(typing()).toHaveValue("echo hi")
      await expect.element(ready()).toBeVisible()
    })

    it("lets Escape close the terminal switcher", async () => {
      await noticeUp()
      await press("{Control>}{Tab}")
      await expect.element(recentSwitcher()).toBeVisible()
      await press("{Escape}")
      await expect.element(recentSwitcher()).not.toBeInTheDocument()
      await expect.element(ready()).toBeVisible()
    })

    it("lets Escape, Enter or typing end navigating", async () => {
      await noticeUp()
      await enterNavigateMode()
      await press("{Escape}")
      await expectTypingIn("Dev server")
      await enterNavigateMode()
      await press("{Enter}")
      await expectTypingIn("Dev server")
      await enterNavigateMode()
      await press("a")
      await expectTypingIn("Dev server")
      await expect.element(ready()).toBeVisible()
    })

    it("hands focus back to the terminal when the footer is clicked", async () => {
      await noticeUp()
      await focusStage()
      await page
        .getByText(/running$/)
        .last()
        .click()
      await expect.element(typing()).toHaveFocus()
    })

    it("leaves focus in the terminal when its buttons are clicked with the mouse", async () => {
      await noticeUp()
      await later(ready()).click()
      await expect.element(ready()).not.toBeInTheDocument()
      await expect.element(typing()).toHaveFocus()
    })

    it("returns focus to the terminal after Later pressed from the keyboard", async () => {
      await noticeUp()
      later(ready()).element().focus()
      await press("{Enter}")
      await expect.element(ready()).not.toBeInTheDocument()
      await expect.element(typing()).toHaveFocus()
    })

    it("keeps focus in the terminal when its text or padding is clicked", async () => {
      await noticeUp()
      await ready().getByText("Novadeck 0.0.80 is ready").click()
      await expect.element(typing()).toHaveFocus()
    })

    it("takes focus on the panel itself when the chip opens it, not on a button", async () => {
      await noticeUp()
      await later(ready()).click()
      await chip().click()
      await expect.element(ready()).toHaveFocus()
    })

    it("lets Shift+Escape from inside it start navigating, and plain Escape close it", async () => {
      await noticeUp()
      await later(ready()).click()
      await chip().click()
      await expect.element(ready()).toHaveFocus()
      await press("{Shift>}{Escape}{/Shift}")
      await expect.element(navigateChip()).toBeVisible()
      await expect.element(ready()).toBeVisible()
    })

    it("closes on Escape in Canvas without moving the camera back to its origin", async () => {
      await openWorkspace("/?demo=update")
      await chooseView("Canvas")
      await later(ready()).click()
      await doubleClickHeader("Checkout implementation")
      await expect.poll(() => fillsView(checkout())).toBe(true)
      const zoomed = checkout()
      await chip().click()
      await expect.element(ready()).toHaveFocus()
      await press("{Escape}")
      await expect.element(ready()).not.toBeInTheDocument()
      await new Promise((done) => setTimeout(done, 600))
      expect(sameBox(checkout(), zoomed)).toBe(true)
    })

    it("returns focus to the chip after a dialog opened from inside it closes", async () => {
      await noticeUp()
      await later(ready()).click()
      await chip().click()
      await expect.element(ready()).toHaveFocus()
      await pressShortcut("find")
      await expect.element(findDialog()).toBeVisible()
      await expectStaysAbsent(ready())
      await press("{Escape}")
      await expect.element(findDialog()).not.toBeInTheDocument()
      await expect.element(chip()).toHaveFocus()
    })

    it("moves focus in when the chip opens it, and Escape returns it to the chip", async () => {
      await noticeUp()
      await later(ready()).click()
      await chip().click()
      await expect.element(ready()).toBeVisible()
      await expect.poll(() => ready().element().contains(document.activeElement)).toBe(true)
      await press("{Escape}")
      await expect.element(ready()).not.toBeInTheDocument()
      await expect.element(chip()).toHaveFocus()
      await expect.element(chip()).toHaveAttribute("aria-expanded", "false")
    })
  })

  context("while a subscription's detail or a menu is open", () => {
    const open = async (): Promise<void> => {
      await openWorkspace("/?demo=agents&update=ready")
      const skip = page.getByRole("button", { name: "Skip for now" })
      if (await skip.query()) await skip.click()
      await expect.element(ready()).toBeVisible()
    }

    it("waits behind the subscription's detail, and returns when it closes", async () => {
      await open()
      await pill().click()
      await expect
        .element(page.getByRole("dialog", { name: "Claude Code subscription" }))
        .toBeVisible()
      await expect.element(ready()).not.toBeInTheDocument()
      await press("{Escape}")
      await expect.element(ready()).toBeVisible()
    })

    it("waits behind a menu, and returns when it closes", async () => {
      await open()
      await pill().click({ button: "right" })
      await expect.element(page.getByRole("menuitem", { name: "Move right" })).toBeVisible()
      await expect.element(ready()).not.toBeInTheDocument()
      await press("{Escape}")
      await expect.element(ready()).toBeVisible()
    })
  })

  context("while a dialog is open", () => {
    it("waits for it to close, and counts as shown only then", async () => {
      await openWorkspace("/?demo=update&dialog=preferences")
      await expect.element(preferencesDialog()).toBeVisible()
      await expectStaysAbsent(ready())
      expect(localStorage.getItem(seenKey)).toBeNull()
      await preferencesDialog().getByRole("button", { name: "Close preferences" }).click()
      await expect.element(preferencesDialog()).not.toBeInTheDocument()
      await expect.element(ready()).toBeVisible()
      expect(localStorage.getItem(seenKey)).toBe("ready:0.0.80")
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
    await openWorkspace("/?demo=update")
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
