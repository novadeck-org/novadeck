import { describe as context, describe, expect, it } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { switchProject } from "./support/sessions"
import {
  chooseView,
  commandInput,
  expectStaysAbsent,
  openWorkspace,
  terminal,
  terminalTab,
} from "./support/workspace"

// The agents demo's Claude Code in Build is idle at its prompt; a prompt there works a moment
// (2 s here) and finishes. Murmur's offer is a chip beside the title of a terminal that
// finishes on screen under its plain name, so the specs prompt Build.
const promptBuild = async (murmur: string, { away = false } = {}): Promise<void> => {
  await openWorkspace(`/?demo=agents&murmur=${murmur}&turnMs=2000`)
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
  await terminalTab("Build").click()
  await commandInput("Build").fill("Ship the docs")
  await userEvent.keyboard("{Enter}")
  await expect.element(terminal("Build")).toHaveAttribute("data-terminal-phase", "running")
  // Looking at another project as the turn ends, one whose agent finishes nothing itself.
  if (away) await switchProject("docs-site")
}

const chip = (): Locator => page.getByRole("button", { name: "Name it for me" })
const popover = (): Locator =>
  page.getByRole("dialog", { name: "Name terminals from what they do" })
// Named by what it shows: Murmur, and how far along.
const footerItem = (): Locator => page.getByRole("button", { name: /^Murmur( \d+%)?$/ })
const doneItem = (): Locator => page.getByRole("button", { name: "Terminals name themselves now" })

// How long past the end of a turn a chip that is going to come up has come up: the turn, and
// the moment an Escape could still turn its finish into an interruption.
const afterTurn = 5000

const preferencesMurmur = async (): Promise<Locator> => {
  await page.getByRole("button", { name: "Workspace preferences" }).click()
  await page.getByRole("tab", { name: "Addons" }).click()
  return page.getByRole("region", { name: "Murmur" })
}

describe("Murmur's one-time offer", () => {
  context("when the first agent finishes on screen and Murmur is not on the computer", () => {
    it("puts a chip beside that terminal's title, with no ×", async () => {
      await promptBuild("uninstalled")

      await expect.element(chip(), { timeout: 10_000 }).toBeVisible()
      await expect.element(chip()).toHaveTextContent("Name it for me")
      await expect
        .element(page.getByRole("button", { name: /^Close Name it/ }))
        .not.toBeInTheDocument()
    })

    it("opens a popover with the size and the answers, focus off the buttons, and Esc dismisses it", async () => {
      await promptBuild("uninstalled")
      await chip().click({ timeout: 10_000 })

      await expect.element(popover()).toBeVisible()
      await expect
        .element(
          popover().getByText(
            "A small model on this computer reads the agent's work and names each terminal. 1.2 GB once.",
          ),
        )
        .toBeVisible()
      await expect.element(popover().getByText(/Preferences → Addons/)).toBeVisible()
      // Not on No thanks, where a reflexive Enter would turn Murmur down for good.
      await expect
        .poll(() => document.activeElement?.textContent)
        .toBe("Name terminals from what they do")
      expect(document.activeElement?.tagName).not.toBe("BUTTON")

      await userEvent.keyboard("{Escape}")
      await expect.element(popover()).not.toBeInTheDocument()
      // A dismiss, not a decline: the chip stays and Murmur is still wanted. Focus is back in
      // the terminal, not left on the chip.
      await expect.element(chip()).toBeVisible()
      await expect
        .poll(() => terminal("Build").element().contains(document.activeElement))
        .toBe(true)
      expect(document.activeElement).not.toBe(chip().element())
      const card = await preferencesMurmur()
      await expect
        .element(card.getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "true")
    })

    it("leaves focus where the person put it when a press outside closes the popover", async () => {
      await promptBuild("uninstalled")
      await chip().click({ timeout: 10_000 })
      await expect.element(popover()).toBeVisible()

      await terminalTab("Tests").click()
      await expect.element(popover()).not.toBeInTheDocument()
      await new Promise((resolve) => setTimeout(resolve, 400))
      // Not taken back to Build: the terminal they pressed is still the one shown, and focus
      // is not on the chip's popover or on the chip.
      await expect.element(terminal("Tests")).toBeVisible()
      expect(popover().query()).toBeNull()
      expect(document.activeElement).not.toBe(chip().query())
    })

    it("keeps a right-click in the popover from opening the terminal's own menu", async () => {
      await promptBuild("uninstalled")
      await chip().click({ timeout: 10_000 })
      await popover().getByText("Name terminals from what they do").click({ button: "right" })
      await expect.element(page.getByRole("menu")).not.toBeInTheDocument()

      // The chip is the window's own, and a right-click there does reach it.
      await chip().click({ button: "right" })
      await expect.element(page.getByRole("menu")).toBeVisible()
    })

    it("turns on into the footer item, then says it is done, and the chip is gone", async () => {
      await promptBuild("uninstalled")
      await chip().click({ timeout: 10_000 })
      await popover().getByRole("button", { name: "Turn on" }).click()

      await expect.element(popover()).not.toBeInTheDocument()
      await expect.element(chip()).not.toBeInTheDocument()
      await expect.element(footerItem()).toBeVisible()
      await expect.element(doneItem(), { timeout: 12_000 }).toBeVisible()
      await expect.element(doneItem(), { timeout: 10_000 }).not.toBeInTheDocument()
    })

    it("opens the item's sheet with the step, the bar and Cancel, and Esc closes it", async () => {
      await promptBuild("uninstalled")
      await chip().click({ timeout: 10_000 })
      await popover().getByRole("button", { name: "Turn on" }).click()
      await footerItem().click()

      const sheet = page.getByRole("region", { name: "Setting up Murmur" })
      await expect.element(sheet.getByText(/Downloading/)).toBeVisible()
      await expect.element(sheet.getByRole("progressbar")).toBeVisible()
      // Opened by a press, it holds focus, so Esc closes it.
      await userEvent.keyboard("{Escape}")
      await expect.element(sheet).not.toBeInTheDocument()
      await footerItem().click()
      await sheet.getByRole("button", { name: "Cancel" }).click()
      await expect.element(footerItem()).not.toBeInTheDocument()
    })

    it("turns Murmur down for good on No thanks, and Preferences shows it off", async () => {
      await promptBuild("uninstalled")
      await chip().click({ timeout: 10_000 })
      await popover().getByRole("button", { name: "No thanks" }).click()
      await expect.element(chip()).not.toBeInTheDocument()

      const card = await preferencesMurmur()
      await expect
        .element(card.getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "false")
    })

    it("shrinks to its icon in a narrow Grid tile, and the name stays", async () => {
      await openWorkspace("/?demo=agents&murmur=uninstalled&turnMs=2000")
      const skip = page.getByRole("button", { name: "Skip for now" })
      if (await skip.query()) await skip.click()
      await chooseView("Grid")
      await terminalTab("Build").click()
      await commandInput("Build").fill("Ship the docs")
      await userEvent.keyboard("{Enter}")

      await expect.element(chip(), { timeout: 10_000 }).toBeVisible()
      await expect.element(page.getByText("Name it for me", { exact: true })).not.toBeVisible()
      await expect.element(terminal("Build").getByRole("heading", { name: "Build" })).toBeVisible()
    })
  })

  // The same prompt and the same wait for each; the control shows the chip, the rest do not.
  it("with Murmur not on the computer, a finished turn shows a chip (the control)", async () => {
    await promptBuild("uninstalled")

    await expect.element(chip(), { timeout: 10_000 }).toBeVisible()
  })

  it.each(["unsupported", "offered-out", "installed"] as const)(
    "with Murmur %s, a finished turn shows no chip",
    async (murmur) => {
      await promptBuild(murmur)

      await expectStaysAbsent(chip(), { ms: afterTurn })
      expect(chip().query()).toBeNull()
    },
  )

  context("when the finished terminal does not qualify", () => {
    it("lets go of a finish in a session that is not on screen, and takes the next that is", async () => {
      await promptBuild("uninstalled", { away: true })
      await expectStaysAbsent(chip(), { ms: afterTurn })

      // Back at Build, a turn that ends on screen is the one.
      await switchProject("storefront")
      await terminalTab("Build").click()
      await commandInput("Build").fill("And the changelog")
      await userEvent.keyboard("{Enter}")
      await expect.element(chip(), { timeout: 12_000 }).toBeVisible()
    })
  })

  context("when the install fails on the network", () => {
    it("turns the footer item to danger and opens its sheet once, with Try again", async () => {
      await promptBuild("network-down")
      await chip().click({ timeout: 10_000 })
      await popover().getByRole("button", { name: "Turn on" }).click()

      const sheet = page.getByRole("region", { name: "Couldn't turn on Murmur" })
      await expect.element(sheet, { timeout: 12_000 }).toBeVisible()
      await expect.element(sheet.getByText(/connection dropped/)).toBeVisible()
      await expect.element(sheet.getByRole("button", { name: "Not now" })).toBeVisible()
      await expect
        .element(page.getByRole("button", { name: "Murmur · failed" }))
        .toHaveAttribute("data-tone", "danger")

      // Try again installs afresh, and the second goes through to done.
      await sheet.getByRole("button", { name: "Try again" }).click()
      await expect.element(doneItem(), { timeout: 15_000 }).toBeVisible()
    })

    it("hides the item on Not now, and it is no decline", async () => {
      await promptBuild("network-down")
      await chip().click({ timeout: 10_000 })
      await popover().getByRole("button", { name: "Turn on" }).click()
      const sheet = page.getByRole("region", { name: "Couldn't turn on Murmur" })
      await sheet.getByRole("button", { name: "Not now" }).click({ timeout: 12_000 })

      await expect.element(sheet).not.toBeInTheDocument()
      const card = await preferencesMurmur()
      await expect
        .element(card.getByRole("switch", { name: "Enabled" }))
        .toHaveAttribute("aria-checked", "true")
    })
  })

  context("when the computer can't run Murmur", () => {
    it("says so in the footer's sheet when Turn on finds it can't, and the item leaves", async () => {
      await promptBuild("no-device")
      await chip().click({ timeout: 10_000 })
      await popover().getByRole("button", { name: "Turn on" }).click()

      const sheet = page.getByRole("region", { name: "Not available on this computer" })
      await expect.element(sheet, { timeout: 12_000 }).toBeVisible()
      await sheet.getByText("Details").click()
      await expect.element(sheet.getByText(/graphics device/)).toBeVisible()
      await sheet.getByRole("button", { name: "Close" }).click()
      await expect.element(sheet).not.toBeInTheDocument()
      await expect
        .element(page.getByRole("button", { name: /Murmur isn't available/ }))
        .not.toBeInTheDocument()
    })
  })
})
