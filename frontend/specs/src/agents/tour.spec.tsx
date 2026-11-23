import { beforeEach, onTestFinished } from "vitest"
import { cleanup } from "vitest-browser-react"
import { page, userEvent, type Locator } from "vitest/browser"

import { helpButton, switchTourOn, takeTourFromHelp } from "../support/help"
import { closePreferences, openPreferencesOn, preferencesDialog } from "../support/keyboard"
import { workspaceSwitcher } from "../support/sessions"
import { consent } from "../support/tour"
import { expectSelected, openWorkspace, terminalTabNames } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// Offered with Experimental on; its demo agent stops after its first step, as these specs need.
const offered = "/?tourStory=off&channel=experimental"

const welcome = (): Locator => page.getByRole("dialog", { name: "Welcome to Novadeck" })
const start = (): Locator => consent().getByRole("button", { name: "Start the tour" })
// Waits for the consent to say `words`, among the rest of what it says.
const consentSays = (words: string): Promise<void> =>
  expect.poll(() => consent().query()?.textContent ?? "").toContain(words)

// The tour is on screen: its own project, with its one terminal, its agent's, selected.
const expectTourOpen = async (): Promise<void> => {
  await expect.poll(() => workspaceSwitcher().element().textContent ?? "").toContain("Tour")
  await expect.poll(() => terminalTabNames().length).toBe(1)
  await expectSelected(terminalTabNames()[0]!)
}

// Offers the tour from the footer's Help menu; with `connect`, Claude Code is connected first,
// in Preferences' Agents (the demo starts with none).
const offerFromHelp = async ({ connect = true } = {}): Promise<void> => {
  if (connect) {
    await openPreferencesOn("Agents")
    const claude = preferencesDialog().getByRole("switch", { name: "Claude Code" })
    await claude.click()
    await expect.element(claude).toHaveAttribute("aria-checked", "true")
    await closePreferences()
  }
  await takeTourFromHelp()
}

// The footer offers the tour only with its own switch on, in Preferences → Experimental.
beforeEach(switchTourOn)

describe("The tour", () => {
  it("is offered only with Experimental on, from the footer's Help menu", async () => {
    await openWorkspace("/?tourStory=off")
    await expect.element(helpButton()).not.toBeInTheDocument()
  })

  it("is offered only with its own switch on, which Preferences → Experimental turns on", async () => {
    localStorage.removeItem("novadeck.preferences")
    await openWorkspace(offered)
    // Its Experimental tab shows: the flag is on, and the switch, off, holds Help back. The
    // Help menu holds the tour alone, so with its switch off there is no Help at all.
    await openPreferencesOn("Experimental")
    const tourSwitch = preferencesDialog().getByRole("switch", { name: "Onboarding tour" })
    await expect.element(tourSwitch).toHaveAttribute("aria-checked", "false")
    expect(helpButton().query()).toBeNull()
    await tourSwitch.click()
    await expect.element(tourSwitch).toHaveAttribute("aria-checked", "true")
    await closePreferences()
    await expect.element(helpButton()).toBeVisible()
  })

  it("is offered nowhere where the backend has no tour, its switch not available", async () => {
    // The showcase demo follows the experimental channel and has no tour.
    await openWorkspace("/?demo=showcase&channel=experimental")
    await openPreferencesOn("Experimental")
    const tourSwitch = preferencesDialog().getByRole("switch", { name: "Onboarding tour" })
    await expect.element(tourSwitch).toBeDisabled()
    await expect.element(preferencesDialog().getByText("Not available here.").first()).toBeVisible()
    await closePreferences()
    await expect.element(page.getByRole("button", { name: "Feedback", exact: true })).toBeVisible()
    expect(helpButton().query()).toBeNull()
  })

  it("is offered nowhere else: not in the welcome dialog, nor in Preferences' About", async () => {
    await openWorkspace("/?demo=welcome&channel=experimental")
    await expect.element(welcome()).toBeVisible()
    expect(welcome().getByRole("button", { name: "Take the tour" }).query()).toBeNull()
    await welcome().getByRole("button", { name: "Let’s build something" }).click()
    await openPreferencesOn("About")
    expect(preferencesDialog().getByRole("button", { name: "Take the tour" }).query()).toBeNull()
  })

  context("offered from the footer's Help menu", () => {
    it("asks first, saying what it runs, where, and how to stop it", async () => {
      await openWorkspace(offered)
      await offerFromHelp()
      await consentSays(
        "Your own agent leads a small team that builds a little browser game you choose.",
      )
      await consentSays(
        "You answer a question or two, approve one command, and play the game at the end.",
      )
      await consentSays(
        "Runs three Claude Code agents on its cheapest model, on your own account, for about 5 minutes.",
      )
      await consentSays(
        "Works in a sandbox repo under ~/.novadeck, made fresh each time. A game you finish is yours to keep.",
      )
      await consentSays("Close the tour's terminal to stop it at any time.")
      await expect.element(start()).toHaveFocus()
    })

    it("offers a choice of agent only where more than one can run it", async () => {
      await openWorkspace(offered)
      await offerFromHelp()
      await consentSays("Runs three Claude Code agents")
      const picker = consent().getByRole("radiogroup", { name: "Agent for the tour" })
      expect(picker.query()).toBeNull()
      await consent().getByRole("button", { name: "Not now" }).click()
      await expect.element(consent()).not.toBeInTheDocument()
      await openPreferencesOn("Agents")
      const codex = preferencesDialog().getByRole("switch", { name: "Codex" })
      await codex.click()
      await expect.element(codex).toHaveAttribute("aria-checked", "true")
      await closePreferences()
      await takeTourFromHelp()
      await expect.element(picker).toBeVisible()
      await expect.element(picker.getByRole("radio", { name: "Claude Code" })).toBeVisible()
      await expect.element(picker.getByRole("radio", { name: "Codex" })).toBeVisible()
      expect(picker.getByRole("radio", { name: "Antigravity" }).query()).toBeNull()
    })

    it("opens the Tour project with its agent starting on its cheapest model", async () => {
      await openWorkspace(offered)
      const before = terminalTabNames()
      await offerFromHelp()
      await start().click()
      await expect.element(consent()).not.toBeInTheDocument()
      expect(before).not.toContain("Tour")
      await expectTourOpen()
    })

    it("starts nothing where it was turned down", async () => {
      await openWorkspace(offered)
      const before = terminalTabNames()
      await offerFromHelp()
      await consent().getByRole("button", { name: "Not now" }).click()
      await expect.element(consent()).not.toBeInTheDocument()
      expect(terminalTabNames()).toEqual(before)
    })

    it("says to connect an agent first where none is", async () => {
      await openWorkspace(offered)
      await offerFromHelp({ connect: false })
      await consentSays("Install and connect Claude Code, Codex or Antigravity")
      expect(start().query()).toBeNull()
      await consent().getByRole("button", { name: "Close" }).click()
      await expect.element(consent()).not.toBeInTheDocument()
    })

    it("says why it couldn't start, staying open to try again", async () => {
      await openWorkspace(`${offered}&tourStart=fails`)
      await offerFromHelp()
      await start().click()
      await consentSays("holds files Novadeck didn't put there")
      // The next try goes, the folder now fine.
      await start().click()
      await expectTourOpen()
    })

    it("opens nothing where it couldn't start", async () => {
      await openWorkspace(`${offered}&tourStart=fails`)
      const before = terminalTabNames()
      await offerFromHelp()
      await start().click()
      await consentSays("holds files Novadeck didn't put there")
      await consent().getByRole("button", { name: "Not now" }).click()
      await expect.element(consent()).not.toBeInTheDocument()
      expect(terminalTabNames()).toEqual(before)
      await expect.element(workspaceSwitcher()).not.toHaveTextContent("Tour")
    })
  })

  it("offers to start an agent that hasn't listed its models yet", async () => {
    await openWorkspace(`${offered}&tourStart=unlisted`)
    await offerFromHelp()
    await start().click()
    await consentSays("hasn't listed its models here yet")
    await consent().getByRole("button", { name: "Start Claude Code" }).click()
    await expect.element(consent()).not.toBeInTheDocument()
    await expectSelected("claude")
  })
})

describe("The footer's Help chip", () => {
  const chip = (): Locator => page.getByRole("button", { name: "Help", exact: true })
  const url = "/?tourStory=off&channel=experimental"
  // Opens the menu once and closes it again.
  const openOnce = async (): Promise<void> => {
    await chip().click()
    await expect.element(page.getByRole("menuitem", { name: "Take the tour" })).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect
      .element(page.getByRole("menuitem", { name: "Take the tour" }))
      .not.toBeInTheDocument()
  }

  it("keeps Help and Feedback named at a narrow width, their words hidden", async () => {
    onTestFinished(() => page.viewport(1440, 900))
    await page.viewport(600, 800)
    await openWorkspace(url)
    await expect.element(chip()).toBeVisible()
    await expect.element(chip().getByText("Help")).not.toBeVisible()
    const feedback = page.getByRole("button", { name: "Feedback", exact: true })
    await expect.element(feedback).toBeVisible()
  })

  it("shows its word while new", async () => {
    await openWorkspace(url)
    await expect.element(chip()).toHaveTextContent("Help")
    // Named Help either way, as narrow footers hide the word.
    await expect.element(chip()).toHaveAttribute("aria-label", "Help")
  })

  it("is the icon alone, still named Help, once opened", async () => {
    await openWorkspace(url)
    await openOnce()
    await expect.element(chip()).toHaveAttribute("aria-label", "Help")
    await expect.element(chip()).not.toHaveTextContent("Help")
  })

  it("stays the icon alone across a reload", async () => {
    await openWorkspace(url)
    await openOnce()
    await cleanup()
    await openWorkspace(url)
    await expect.element(chip()).toHaveAttribute("aria-label", "Help")
    await expect.element(chip()).not.toHaveTextContent("Help")
  })
})
