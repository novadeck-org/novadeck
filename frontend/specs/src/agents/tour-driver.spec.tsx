import { beforeEach } from "vitest"
import { page, type Locator } from "vitest/browser"

import { switchTourOn, takeTourFromHelp } from "../support/help"
import {
  closePreferences,
  findDialog,
  openPreferencesOn,
  preferencesDialog,
  pressShortcut,
} from "../support/keyboard"
import { switchProject, workspaceSwitcher } from "../support/sessions"
import { closeConfirmation, confirmClose, tabAction } from "../support/terminals"
import { coach, coachSays, consent, expectLookAt, windowNamed } from "../support/tour"
import {
  expectSelected,
  openWorkspace,
  press,
  sidebarPanel,
  terminalTabNames,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// Its demo agent stops after the first step: these specs are about the driver, not the story.
const offered = "/?tourStory=off&channel=experimental"

const bar = (): Locator => page.getByRole("region", { name: "Tour", exact: true })

// Waits for the bar that stands in for the tour to say `words`.
const barSays = (words: string): Promise<void> =>
  expect.poll(() => bar().query()?.textContent ?? "").toContain(words)

// Starts the tour from the footer's Help menu with Claude Code, connected first in Preferences' Agents.
const startTour = async (address = offered): Promise<void> => {
  await openWorkspace(address)
  await openPreferencesOn("Agents")
  const claude = preferencesDialog().getByRole("switch", { name: "Claude Code" })
  await claude.click()
  await expect.element(claude).toHaveAttribute("aria-checked", "true")
  await closePreferences()
  await takeTourFromHelp()
  await consent().getByRole("button", { name: "Start the tour" }).click()
  await expect.element(consent()).not.toBeInTheDocument()
}

// The tour's lead names itself once its agent has taken the brief, and its first step goes on
// after its caption has shown and been held.
const leadNamed = { timeout: 10_000 }

// The footer offers the tour only with its own switch on, in Preferences → Experimental.
beforeEach(switchTourOn)

describe("The tour's driver", () => {
  it("points at the agent as it starts, and moves on once it has taken its brief", async () => {
    await startTour()
    await coachSays("That's your agent. It runs this job.")
    await expect.element(page.getByText(/^Act 1, Your agent\./)).toBeInTheDocument()
    // The agent describes itself as the tour's lead: its step is done, and holds until its
    // caption has been on screen 3 s, however soon the agent named itself.
    await expect.poll(terminalTabNames, leadNamed).toContain("Game lead")
    // Its next step is the team's: the demo's lead opens none here, so nothing is marked yet and
    // no caption shows, but the act has begun.
    await expect.element(page.getByText(/^Act 2, Your call\./), leadNamed).toBeInTheDocument()
  })

  it("marks the agent's window to look at while it starts, in the page's own element", async () => {
    await startTour(`${offered}&tourAgent=quiet&tourPatienceMs=60000`)
    await coachSays("That's your agent. It runs this job.")
    await expectLookAt(() => windowNamed(terminalTabNames()[0]!))
    // The mark is drawn inside what it marks, not over the page.
    const marked = document.querySelector("[data-tour-look]")!
    expect(marked.matches("[data-terminal]")).toBe(true)
    expect(document.querySelectorAll("[data-tour-click]")).toHaveLength(0)
  })

  it("drops a run kept by a version whose steps were others, rather than follow it at the wrong one", async () => {
    sessionStorage.setItem(
      "novadeck.tour",
      JSON.stringify({
        terminalId: "gone",
        agent: "claude",
        brief: "launch",
        command: "claude",
        page: true,
        step: 3,
        waitingSince: 0,
        nudged: false,
        briefed: true,
        asked: false,
        entered: true,
        tabbed: false,
        doneAt: null,
        // The step it was at is another's here.
        stepId: "model",
      }),
    )
    await openWorkspace(offered)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(coach().query()).toBeNull()
    expect(bar().query()).toBeNull()
  })

  it("leaves the keyboard's focus where it was", async () => {
    await startTour()
    await coachSays("That's your agent. It runs this job.")
    expect(coach().element().contains(document.activeElement)).toBe(false)
  })

  it("leaves the workspace's shortcuts, and Escape, to the person", async () => {
    await startTour(`${offered}&tourAgent=quiet&tourPatienceMs=60000`)
    await coachSays("That's your agent. It runs this job.")
    await pressShortcut("find")
    await expect.element(findDialog()).toBeVisible()
    await press("{Escape}")
    await expect.element(findDialog()).not.toBeInTheDocument()
    // The coach stays, as nothing it asked for was dismissed.
    await coachSays("That's your agent. It runs this job.")
  })

  context("while the agent asks the person something of its own first", () => {
    it("says so, with its screen's own words, and goes on once it's answered", async () => {
      await startTour(`${offered}&tourScreen=sign-in&tourScreenMs=1500`)
      await coachSays("It wants an answer first.")
      await coachSays("sign in")
      await expect.poll(terminalTabNames, leadNamed).toContain("Game lead")
    })

    it("says what folder trust asks", async () => {
      await startTour(`${offered}&tourScreen=startup&tourScreenMs=1500`)
      await coachSays('pick "Yes, I trust this folder" here (it starts on "No")')
    })

    it("says what Novadeck's hooks being off asks", async () => {
      await startTour(`${offered}&tourScreen=hooks&tourScreenMs=1500`)
      await coachSays("Turn hooks back on in its settings")
    })
  })

  context("while the agent asks the person's permission", () => {
    it("points at its terminal, and goes on once the person has answered", async () => {
      await startTour(`${offered}&tourAgent=permission&tourPatienceMs=500`)
      await coachSays("It's asking your permission.")
      await coachSays("Answer it here, in its terminal")
      // The person's wait isn't the agent's silence: no nudge or move on comes meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await coachSays("It's asking your permission.")
      expect(terminalTabNames()).not.toContain("Game lead")

      // The terminal on screen holds its own agent's rows out of the Inbox, so the person looks
      // away first, and answers there.
      await switchProject("storefront")
      await sidebarPanel("Inbox").click()
      await page
        .getByRole("list", { name: "Messages from your agents" })
        .getByRole("button", { name: /^Unblock: Run pnpm lint/ })
        .first()
        .click()
      // The agent's context comes in late, and a click just after the card moved is held back.
      await new Promise((resolve) => setTimeout(resolve, 800))
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Yes, proceed", exact: true })
        .click()

      await bar().getByRole("button", { name: "Back to the tour" }).click()
      await expect.element(page.getByText(/^Act 2, Your call\./), leadNamed).toBeInTheDocument()
      // The Inbox the person answered in is still open: the terminals are listed in their panel.
      await sidebarPanel("Terminals").click()
      await expect.poll(terminalTabNames, leadNamed).toContain("Game lead")
    })
  })

  context("while the agent's program has ended and its shell is back", () => {
    it("says it didn't start, pointing at its terminal, and what to do", async () => {
      await startTour(`${offered}&tourAgent=shell&tourPatienceMs=60000`)
      await coachSays("It didn't start.")
      await coachSays("Its terminal says why. End the tour and take it again.")
      expect(document.querySelectorAll("[data-tour-click]")).toHaveLength(1)
      await page.getByRole("button", { name: "End tour" }).click()
      await expect.element(coach()).not.toBeInTheDocument()
    })
  })

  it("nudges an agent gone quiet, which then goes on", async () => {
    await startTour(`${offered}&tourAgent=quiet&tourPatienceMs=600`)
    await coachSays("That's your agent. It runs this job.")
    // Quiet, it never names itself unless nudged.
    await expect.poll(terminalTabNames, leadNamed).toContain("Game lead")
  })

  context("as the person leaves it", () => {
    it("ends, leaving its terminal as it is", async () => {
      await startTour(`${offered}&tourAgent=quiet&tourPatienceMs=60000`)
      await page.getByRole("button", { name: "End tour" }).click()
      await expect.element(coach()).not.toBeInTheDocument()
      expect(bar().query()).toBeNull()
      expect(terminalTabNames()).toHaveLength(1)
    })

    it("gives way while the person is in another project, and takes them back", async () => {
      await startTour(`${offered}&tourAgent=quiet&tourPatienceMs=60000`)
      await coachSays("That's your agent. It runs this job.")
      await switchProject("storefront")
      await expect.element(coach()).not.toBeInTheDocument()
      await barSays("The tour goes on in its project.")
      await bar().getByRole("button", { name: "Back to the tour" }).click()
      await expect.poll(() => workspaceSwitcher().element().textContent ?? "").toContain("Tour")
      await expectSelected(terminalTabNames()[0]!)
      await coachSays("That's your agent. It runs this job.")
    })
  })

  it("ends when its lead's terminal closes", async () => {
    await startTour(`${offered}&tourAgent=quiet&tourPatienceMs=60000`)
    await coachSays("That's your agent. It runs this job.")
    await tabAction(`Close ${terminalTabNames()[0]}`).click()
    // A running agent asks first.
    if (closeConfirmation().query()) await confirmClose()
    await expect.element(coach()).not.toBeInTheDocument()
    expect(bar().query()).toBeNull()
  })
})
