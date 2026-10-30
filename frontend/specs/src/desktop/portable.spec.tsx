import { afterEach } from "vitest"
import { cleanup } from "vitest-browser-react"
import { page, type Locator } from "vitest/browser"

import { portableInstall } from "../support/backend"
import { expectStaysAbsent, isMac, openWorkspace, press } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// Closing the window doesn't quit the app on macOS, so there a restart is a quit and a reopen.
const takesEffect = isMac()
  ? "Takes effect after you quit and reopen Novadeck"
  : "Takes effect after you restart Novadeck"

// The footer's chips come before the card in the page, which has its own buttons.
const install = (): Locator =>
  page.getByRole("button", { name: "Install Novadeck", exact: true }).first()
const update = (): Locator => page.getByRole("button", { name: /^Update available:/ }).first()
const installedChip = (): Locator => page.getByRole("button", { name: /^Installed:/ })
const installingChip = (): Locator => page.getByRole("button", { name: "Installing…", exact: true })
const sandbox = (): Locator => page.getByRole("button", { name: /^No sandbox:/ })
const quiet = (): Locator => page.getByRole("region", { name: "Portable copy" })
// With the release's notes the card is a changelog under the tape; without them it is the
// title and a line.
const offered = (): Locator => page.getByRole("region", { name: "New in Novadeck 0.0.80" })
const offeredPlain = (): Locator => page.getByRole("region", { name: "Novadeck 0.0.80 is out" })
const installing = (): Locator => page.getByRole("region", { name: "Installing Novadeck" })
const done = (): Locator => page.getByRole("region", { name: "Novadeck installed" })
const dismiss = (card: Locator): Locator => card.getByRole("button", { name: "Dismiss" })
const primary = (card: Locator): Locator =>
  card.getByRole("button", { name: "Install Novadeck", exact: true })

describe("a portable copy's install card", () => {
  afterEach(() => page.viewport(1440, 900))

  it("is absent where the app has no portable copy", async () => {
    await openWorkspace()
    await expectStaysAbsent(install())
    await expectStaysAbsent(quiet())
    expect(install().query()).toBeNull()
  })

  context("with no release known", () => {
    it("comes up by itself, saying what a portable copy lacks, without taking focus", async () => {
      await openWorkspace("/?portable=no-release")
      await expect.element(quiet()).toBeVisible()
      await expect.element(quiet().getByText("Updates need an installed Novadeck.")).toBeVisible()
      // Text matches whole (not by part) by default: the line is one sentence around the path.
      await expect
        .element(quiet().getByText("Your workspace stays in /home/you/.config/novadeck"))
        .toBeVisible()
      await expect.element(quiet().getByRole("button", { name: "Show folder" })).toBeVisible()
      await expect.element(quiet()).not.toHaveFocus()
      await expect.element(install()).toBeVisible()
      await expect
        .element(quiet().getByRole("button", { name: "Release notes" }))
        .not.toBeInTheDocument()
      await expect.element(quiet().getByRole("button", { name: "Later" })).not.toBeInTheDocument()
    })

    it("folds into the chip on ×, and the chip opens it again with focus", async () => {
      await openWorkspace("/?portable=no-release")
      await dismiss(quiet()).click()
      await expect.element(quiet()).not.toBeInTheDocument()
      await install().click()
      await expect.element(quiet()).toBeVisible()
      await expect.element(quiet()).toHaveFocus()
    })

    it("folds on Escape from inside it and returns focus to the chip", async () => {
      await openWorkspace("/?portable=no-release")
      await dismiss(quiet()).click()
      await install().click()
      await expect.element(quiet()).toHaveFocus()
      await press("{Escape}")
      await expect.element(quiet()).not.toBeInTheDocument()
      await expect.element(install()).toHaveFocus()
    })

    it("does not come up by itself again after a page reload in the same launch", async () => {
      await openWorkspace("/?portable=no-release")
      await expect.element(quiet()).toBeVisible()
      await cleanup()
      await openWorkspace("/?portable=no-release")
      await expect.element(install()).toBeVisible()
      await expectStaysAbsent(quiet())
    })

    it("shortens the chip to its icon on a narrow bar", async () => {
      await page.viewport(600, 800)
      await openWorkspace("/?portable=no-release")
      await expect.element(install()).toBeVisible()
      expect(
        install().element().querySelector("svg")!.getBoundingClientRect().width,
      ).toBeGreaterThan(0)
      await expect
        .element(install().getByText("Install Novadeck", { exact: true }))
        .not.toBeVisible()
    })

    it("says nothing of the sandbox where the app runs sandboxed", async () => {
      await openWorkspace("/?portable=no-release")
      await expect.element(quiet()).toBeVisible()
      await expect.element(quiet().getByText(/sandbox/)).not.toBeInTheDocument()
    })
  })

  context("while installing", () => {
    it("shows Installing Novadeck with the chip reading Installing…", async () => {
      await openWorkspace("/?portable=never")
      await primary(quiet()).click()
      await expect.element(installing()).toBeVisible()
      await expect.element(installing().getByText("Keeps your workspace")).toBeVisible()
      await expect.element(dismiss(installing())).toBeVisible()
      await expect.element(installingChip()).toHaveTextContent("Installing…")
    })

    it("folds into the chip on ×, which reopens it, and on Escape back to the chip", async () => {
      await openWorkspace("/?portable=never")
      await primary(quiet()).click()
      await dismiss(installing()).click()
      await expect.element(installing()).not.toBeInTheDocument()
      await installingChip().click()
      await expect.element(installing()).toBeVisible()
      await expect.element(installing()).toHaveFocus()
      await press("{Escape}")
      await expect.element(installing()).not.toBeInTheDocument()
      await expect.element(installingChip()).toHaveFocus()
    })

    it("raises the card again with the answer once it was folded", async () => {
      await openWorkspace("/?portable=no-release&installMs=stepped")
      await primary(quiet()).click()
      await dismiss(installing()).click()
      await expect.element(installing()).not.toBeInTheDocument()
      portableInstall.advanceTo("installed")
      await expect.element(done()).toBeVisible()
    })
  })

  context("once installed", () => {
    it("says it takes effect after a restart, never restarts, then fades and leaves Installed", async () => {
      await openWorkspace("/?portable=no-release")
      await primary(quiet()).click()
      await expect.element(done()).toBeVisible()
      await expect.element(done().getByText(takesEffect)).toBeVisible()
      await expect.element(done().getByRole("button", { name: /restart/i })).not.toBeInTheDocument()
      await expect.element(done(), { timeout: 8000 }).not.toBeInTheDocument()
      await expect.element(installedChip()).toBeVisible()
      await expect.element(installedChip()).toHaveTextContent("Installed")
    })

    it("lets the chip bring the line back until it is dismissed", async () => {
      await openWorkspace("/?portable=no-release")
      await primary(quiet()).click()
      await expect.element(done(), { timeout: 8000 }).not.toBeInTheDocument()
      await installedChip().click()
      await expect.element(done()).toBeVisible()
      // Opened by the person, it stays past where the first showing faded (4 s and a fade).
      await new Promise((resolve) => setTimeout(resolve, 4500))
      await expect.element(done()).toBeVisible()
      await dismiss(done()).click()
      await expect.element(done()).not.toBeInTheDocument()
    })
  })

  context("when the app reports a download", () => {
    it("shows the percent under Installing Novadeck, then the indeterminate bar", async () => {
      await openWorkspace("/?portable=no-release&installMs=stepped")
      await primary(quiet()).click()
      portableInstall.advanceTo("downloading")
      await expect.element(installing().getByText("Downloading…")).toBeVisible()
      await expect.element(installing().getByText(/^\d+%$/)).toBeVisible()
      portableInstall.advanceTo("installing")
      await expect.element(installing().getByText("Keeps your workspace")).toBeVisible()
      // Nothing to measure now: the bar has no value, rather than a stale percent.
      expect(installing().element().querySelector("[role=progressbar]")).not.toBeNull()
      expect(
        installing().element().querySelector("[role=progressbar]")!.getAttribute("data-state"),
      ).toBe("indeterminate")
      expect(
        installing().element().querySelector("[role=progressbar]")!.hasAttribute("aria-valuenow"),
      ).toBe(false)
      portableInstall.advanceTo("installed")
      await expect.element(done()).toBeVisible()
    })
  })

  context("in a window opened again after installing", () => {
    it("raises no card and reads Installed on the chip", async () => {
      await openWorkspace("/?portable=installed")
      await expect.element(installedChip()).toBeVisible()
      await expectStaysAbsent(done())
      await installedChip().click()
      await expect.element(done()).toBeVisible()
    })
  })

  context("when the install ends otherwise", () => {
    it("says a newer Novadeck is already installed, taking effect after a restart, with no buttons", async () => {
      await openWorkspace("/?portable=newer")
      await primary(quiet()).click()
      const newer = page.getByRole("region", { name: "Novadeck 0.0.99 is already installed" })
      await expect.element(newer).toBeVisible()
      await expect.element(newer.getByText(takesEffect)).toBeVisible()
      await expect.element(primary(newer)).not.toBeInTheDocument()
      await expect
        .element(newer.getByRole("button", { name: /open|restart/i }))
        .not.toBeInTheDocument()
      await dismiss(newer).click()
      await expect.element(newer).not.toBeInTheDocument()
      await expect.element(installedChip()).toBeVisible()
    })

    it("says why it failed and offers Try again", async () => {
      await openWorkspace("/?portable=failed")
      const failed = page.getByRole("region", { name: "Couldn't install" })
      await primary(quiet()).click()
      await expect
        .element(failed.getByRole("alert"))
        .toHaveTextContent("There is no space left on the disk.")
      await failed.getByRole("button", { name: "Try again" }).click()
      await expect
        .element(failed.getByRole("alert"))
        .toHaveTextContent("There is no space left on the disk.")
    })

    it("does not show an earlier failure when the chip opens the card again", async () => {
      await openWorkspace("/?portable=failed")
      await primary(quiet()).click()
      const failed = page.getByRole("region", { name: "Couldn't install" })
      await expect.element(failed.getByRole("alert")).toBeVisible()
      await dismiss(failed).click()
      await expect.element(failed).not.toBeInTheDocument()
      await install().click()
      await expect.element(quiet()).toBeVisible()
      await expect.element(quiet().getByRole("alert")).not.toBeInTheDocument()
    })
  })
})

describe("a portable copy with a release waiting", () => {
  it("turns the chip to Update available and raises the changelog card with Install", async () => {
    await openWorkspace("/?portable=update")
    await expect.element(offered()).toBeVisible()
    await expect.element(offered().getByText("Word handles for terminals")).toBeVisible()
    await expect.element(offered().getByText("From 0.0.70")).toBeVisible()
    await expect.element(primary(offered())).toBeVisible()
    await expect.element(offered().getByRole("button", { name: "Get new portable" })).toBeVisible()
    await expect
      .element(offered().getByRole("button", { name: "Release notes" }))
      .not.toBeInTheDocument()
    await expect.element(update()).toBeVisible()
  })

  it("keeps the card open when Get new portable opens the download page", async () => {
    await openWorkspace("/?portable=update")
    await offered().getByRole("button", { name: "Get new portable" }).click()
    await expect.element(offered()).toBeVisible()
  })

  it("keeps Show folder inside the card at a long Windows data folder", async () => {
    await openWorkspace("/?portable=update-long-path")
    await expect.element(offered()).toBeVisible()
    const folder = offered().getByRole("button", { name: "Show folder" })
    await expect.element(folder).toBeVisible()
    const card = offered().element().getBoundingClientRect()
    const button = folder.element().getBoundingClientRect()
    expect(button.right).toBeLessThanOrEqual(card.right)
    expect(button.left).toBeGreaterThanOrEqual(card.left)
    const words = offered().element().querySelector(".portable-data span")!.getBoundingClientRect()
    expect(words.right).toBeLessThanOrEqual(button.left)
  })

  it("offers Get new portable on an offer from the app's updates alone", async () => {
    await openWorkspace("/?portable=never&update=available")
    await expect
      .element(offeredPlain().getByRole("button", { name: "Get new portable" }))
      .toBeVisible()
  })

  it("falls back to the title and line when the app has no notes", async () => {
    await openWorkspace("/?portable=update-no-news")
    await expect.element(offeredPlain()).toBeVisible()
    await expect.element(offeredPlain().getByText("This copy can't update itself.")).toBeVisible()
    await expect.element(primary(offeredPlain())).toBeVisible()
  })

  it("raises the card once per launch, then only from the chip", async () => {
    await openWorkspace("/?portable=update")
    await expect.element(offered()).toBeVisible()
    await dismiss(offered()).click()
    await cleanup()
    await openWorkspace("/?portable=update")
    await expect.element(update()).toBeVisible()
    await expectStaysAbsent(offered())
    await update().click()
    await expect.element(offered()).toBeVisible()
  })

  it("installs from the card", async () => {
    await openWorkspace("/?portable=never&update=available")
    await primary(offeredPlain()).click()
    await expect.element(installing()).toBeVisible()
    await expect.element(installingChip()).toBeVisible()
  })
})

describe("the sandbox chip on a portable copy", () => {
  it("is not shown, and the card says what installing allows", async () => {
    await openWorkspace("/?portable=no-release&sandbox=off")
    await expect.element(install()).toBeVisible()
    await expectStaysAbsent(sandbox())
    expect(sandbox().query()).toBeNull()
    await expect
      .element(quiet().getByText("Installing also lets you turn on the sandbox."))
      .toBeVisible()
  })

  it("does not flash while the app has yet to say it is a portable copy", async () => {
    await openWorkspace("/?portable=slow-app&sandbox=off")
    // Still waiting for the answer: no install chip yet, and no sandbox chip either.
    expect(install().query()).toBeNull()
    await expectStaysAbsent(sandbox(), { ms: 1000 })
    expect(install().query()).toBeNull()
    await expect.element(install(), { timeout: 8000 }).toBeVisible()
    await expectStaysAbsent(sandbox())
  })

  it("is shown again on an installed copy", async () => {
    await openWorkspace("/?sandbox=off")
    await expect.element(sandbox()).toBeVisible()
  })
})
