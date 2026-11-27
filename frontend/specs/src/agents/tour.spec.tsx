import { onTestFinished } from "vitest"
import { cleanup } from "vitest-browser-react"
import { page, userEvent, type Locator } from "vitest/browser"

import { helpButton, takeTourFromHelp } from "../support/help"
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

// Offers the tour from the footer's Help menu; the demo has Pi in place, unless its address says
// otherwise (`&tourPi=`).
const offerFromHelp = (): Promise<void> => takeTourFromHelp()

describe("The tour", () => {
  it("is offered only with Experimental on, from the footer's Help menu", async () => {
    await openWorkspace("/?tourStory=off")
    await expect.element(helpButton()).not.toBeInTheDocument()
  })

  it("is offered only with Nova on, which Preferences → Experimental turns off and on", async () => {
    await openWorkspace(offered)
    // The demo's tour starts with Nova on and in place; its one switch holds the tour too. The
    // Help menu holds the tour alone, so with Nova off there is no Help at all.
    await expect.element(helpButton()).toBeVisible()
    await openPreferencesOn("Experimental")
    const novaSwitch = preferencesDialog().getByRole("switch", { name: "Nova" })
    await expect.element(novaSwitch).toHaveAttribute("aria-checked", "true")
    expect(preferencesDialog().getByRole("switch", { name: "Onboarding tour" }).query()).toBeNull()
    await novaSwitch.click()
    await expect.element(novaSwitch).toHaveAttribute("aria-checked", "false")
    expect(helpButton().query()).toBeNull()
    await novaSwitch.click()
    await expect.element(novaSwitch).toHaveAttribute("aria-checked", "true")
    await closePreferences()
    await expect.element(helpButton()).toBeVisible()
  })

  it("is offered nowhere where the backend has no tour, whatever Nova says", async () => {
    // The showcase demo follows the experimental channel and has no tour.
    await openWorkspace("/?demo=showcase&channel=experimental")
    await openPreferencesOn("Experimental")
    const novaSwitch = preferencesDialog().getByRole("switch", { name: "Nova" })
    await novaSwitch.click()
    await expect.element(novaSwitch).toHaveAttribute("aria-checked", "true")
    expect(
      preferencesDialog().getByRole("tabpanel", { name: "Experimental" }).element().textContent,
    ).not.toContain("short tour")
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
      await consentSays("Pi agents lead a small team that builds a little browser game you choose.")
      await consentSays(
        "You answer a question or two, approve one command, and play the game at the end.",
      )
      await consentSays(
        "Runs three Nova agents on GPT-6 Luna, free and paid by Novadeck, for about 5 minutes.",
      )
      await consentSays(
        "What the agents read and write goes through novadeck.dev to OpenRouter and Microsoft Azure, which runs OpenAI's model.",
      )
      await consentSays(
        "Works in a sandbox repo under ~/.novadeck, made fresh each time. A game you finish is yours to keep.",
      )
      await consentSays("Downloads Pi, Novadeck's own agent, once: about 50–60 MB.")
      await consentSays("Close the tour's terminal to stop it at any time.")
      await expect.element(start()).toHaveFocus()
    })

    it("offers no choice of agent, whichever others are connected", async () => {
      await openWorkspace(offered)
      await openPreferencesOn("Agents")
      const codex = preferencesDialog().getByRole("switch", { name: "Codex" })
      await codex.click()
      await expect.element(codex).toHaveAttribute("aria-checked", "true")
      await closePreferences()
      await offerFromHelp()
      await consentSays("Runs three Nova agents")
      expect(consent().getByRole("radiogroup").query()).toBeNull()
      expect(consent().getByRole("radio").query()).toBeNull()
    })

    it("opens the Tour project with Pi starting on the tour's model", async () => {
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

    it("says how far Pi's download is, as Nova switched on plays it, and starts once it is in place", async () => {
      await openWorkspace(`${offered}&tourPi=download`)
      await offerFromHelp()
      await consentSays("Downloading Pi")
      await consentSays("MB")
      const waiting = consent().getByRole("button", { name: "Waiting for Pi…" })
      await expect.element(waiting).toHaveAttribute("aria-disabled", "true")
      await expect.element(start(), { timeout: 15_000 }).toBeVisible()
      expect(consent().query()?.textContent).not.toContain("Downloading Pi")
      await start().click()
      await expectTourOpen()
    })

    it("says why Pi's download failed, with a Try again that downloads it again", async () => {
      await openWorkspace(`${offered}&tourPi=fails`)
      await offerFromHelp()
      await consentSays("Couldn't reach github.com. Check your connection.")
      const waiting = consent().getByRole("button", { name: "Start the tour" })
      await expect.element(waiting).toHaveAttribute("aria-disabled", "true")
      await consent().getByRole("button", { name: "Try again" }).click()
      await consentSays("Downloading Pi")
      await expect.element(start(), { timeout: 15_000 }).not.toHaveAttribute("aria-disabled")
      expect(consent().getByRole("button", { name: "Try again" }).query()).toBeNull()
      await start().click()
      await expectTourOpen()
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

  it("shows Nova's model service's own sentence where it has no free ticket to give, staying open", async () => {
    await openWorkspace(`${offered}&tourStart=tickets`)
    await offerFromHelp()
    await start().click()
    await consentSays("You've used today's free Nova tickets. Try again tomorrow.")
    await start().click()
    await expectTourOpen()
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
