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
    await coachSays("Your agent is starting")

    // The lead opens a team, which names itself in the terminal list.
    await coachSays("Your agent opens a team")
    await expect
      .poll(terminalTabNames, { timeout: 15_000 })
      .toEqual(expect.arrayContaining(["Tour lead", "Copywriter", "Designer"]))

    // They talk, as the lead's Messages show.
    await coachSays("The team talks")

    // A teammate asks the person, who answers in the Inbox; the tour waits on them.
    await coachSays("A teammate asks you")
    await inboxRow(/Which tagline for the welcome card/).click()
    const sheet = page.getByRole("dialog", { name: "Copywriter" })
    // Pressed once the card stands still: a click just after it moved is held back.
    const pick = sheet.getByRole("button", { name: /Every agent, one calm workspace/ })
    await standsStill(pick)
    await pick.click()

    // The lead shows the card the team made.
    await coachSays("Your agent shows you the result")

    // Zoom out: Grid, then Canvas, each moved on by the person.
    await coachSays("All your agents at once")
    await expect.element(view("Grid")).toBeChecked()
    await coach().getByRole("button", { name: "Next" }).click()
    await coachSays("Room to spread out")
    await expect.element(view("Canvas")).toBeChecked()
    await coach().getByRole("button", { name: "Next" }).click()

    // It ends on a card that sends the person to their own project.
    await expect.element(coach()).not.toBeInTheDocument()
    await expect.element(closing()).toBeVisible()
    await expect.poll(() => closing().query()?.textContent ?? "").toContain("It ran in a sandbox")
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
