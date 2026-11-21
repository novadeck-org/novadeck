import { beforeEach } from "vitest"
import { page, type Locator } from "vitest/browser"

import { switchTourOn, takeTourFromHelp } from "../support/help"
import { closePreferences, openPreferencesOn, preferencesDialog } from "../support/keyboard"
import { workspaceSwitcher } from "../support/sessions"
import { openWorkspace, terminalTabNames, view } from "../support/workspace"
import { describe, expect, it } from "../test"

const consent = (): Locator => page.getByRole("dialog", { name: "Take the tour" })
const coach = (): Locator => page.getByRole("region", { name: "Tour step" })
const closing = (): Locator => page.getByRole("region", { name: "Tour finished" })
const inboxRow = (words: RegExp): Locator =>
  page.getByRole("list", { name: "Messages from your agents" }).getByRole("button", {
    name: new RegExp(`^(?!(?:Dismiss|Snooze|Unsnooze): ).*(?:${words.source})`),
  })

// Waits until what `locator` finds stops moving: a sheet's card moves as its context comes in.
const standsStill = async (locator: Locator): Promise<void> => {
  let last = Number.NaN
  await expect
    .poll(
      async () => {
        const before = last
        last = locator.element().getBoundingClientRect().top
        await new Promise((resolve) => setTimeout(resolve, 450))
        return before === last && locator.element().getBoundingClientRect().top === last
      },
      { timeout: 10_000, interval: 0 },
    )
    .toBe(true)
}

// Waits for the coach to say `words`, among the rest of what it says.
const coachSays = (words: string, timeout = 15_000): Promise<void> =>
  expect.poll(() => coach().query()?.textContent ?? "", { timeout }).toContain(words)

// Starts the tour from the footer's Help menu with Claude Code, and Codex for a mixed team,
// connected first in Preferences' Agents.
const startTour = async (): Promise<void> => {
  await openWorkspace("/?channel=experimental")
  await openPreferencesOn("Agents")
  for (const name of ["Claude Code", "Codex"]) {
    const agent = preferencesDialog().getByRole("switch", { name })
    // eslint-disable-next-line no-await-in-loop -- One switch at a time, as a person flips them.
    await agent.click()
    // eslint-disable-next-line no-await-in-loop -- Each connected before the next.
    await expect.element(agent).toHaveAttribute("aria-checked", "true")
  }
  await closePreferences()
  await takeTourFromHelp()
  await consent().getByRole("button", { name: "Start the tour" }).click()
  await expect.element(consent()).not.toBeInTheDocument()
}

// The footer offers the tour only with its own switch on, in Preferences → Experimental.
beforeEach(switchTourOn)

describe("The tour's story", () => {
  it("plays from the agent's start to its card, the person's answer and all", async () => {
    await startTour()
    // It opens in Canvas, on the person's own agent.
    await coachSays("Your own agent. In a sandbox.")
    await expect.element(view("Canvas")).toBeChecked()

    // The lead opens a team, which names itself.
    await coachSays("It hired two more.")
    await expect
      .poll(terminalTabNames, { timeout: 15_000 })
      .toEqual(expect.arrayContaining(["Tour lead", "Copywriter", "Designer"]))

    // They talk, as the lead's Messages show.
    await coachSays("They talk to each other.")

    // A teammate asks the person, who answers in the Inbox; the tour waits on them.
    await coachSays("Your call.")
    await expect.element(page.getByText(/^Act 3, Your call\./)).toBeInTheDocument()
    await inboxRow(/Which tagline for the welcome card/).click()
    const sheet = page.getByRole("dialog", { name: "Copywriter" })
    // Pressed once the card stands still: a click just after it moved is held back.
    const pick = sheet.getByRole("button", { name: /Every agent, one calm workspace/ })
    await standsStill(pick)
    await pick.click()

    // The lead shows the card the team made, and the tour holds on it a while.
    await coachSays("Made for you.")
    await expect.element(page.getByText(/^Act 4, The result\./)).toBeInTheDocument()

    // It ends on a card that sends the person to their own project.
    await expect.element(closing(), { timeout: 15_000 }).toBeVisible()
    await expect.element(coach()).not.toBeInTheDocument()
    await expect.poll(() => closing().query()?.textContent ?? "").toContain("That was a sandbox")
    // The demo has no folder picker to open a project with, so the card offers none.
    expect(closing().getByRole("button", { name: "Open your project" }).query()).toBeNull()

    // And offers to remove the Tour project.
    await closing().getByRole("button", { name: "Remove the Tour project" }).click()
    await expect.poll(() => workspaceSwitcher().element().textContent ?? "").not.toContain("Tour")
    expect(closing().getByRole("button", { name: "Remove the Tour project" }).query()).toBeNull()
    await closing().getByRole("button", { name: "Close" }).click()
    await expect.element(closing()).not.toBeInTheDocument()
  })
})
