import { beforeEach } from "vitest"
import { page, type Locator } from "vitest/browser"

import { switchTourOn, takeTourFromHelp } from "../support/help"
import { closePreferences, openPreferencesOn, preferencesDialog } from "../support/keyboard"
import { switchProject, workspaceSwitcher } from "../support/sessions"
import { newTerminalButton } from "../support/terminals"
import { openWorkspace, sidebarPanel, terminalTabNames, view } from "../support/workspace"
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
  await beginTour()
}

// The same, in the workspace already open.
const beginTour = async (): Promise<void> => {
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
  it("shows the Worktrees panel in the tour's project even with Agent worktrees off, and only there", async () => {
    await openWorkspace("/?channel=experimental")
    await openPreferencesOn("Experimental")
    const worktrees = preferencesDialog().getByRole("switch", { name: "Agent worktrees" })
    if ((await worktrees.element().getAttribute("aria-checked")) === "true") await worktrees.click()
    await expect.element(worktrees).toHaveAttribute("aria-checked", "false")
    await closePreferences()
    expect(sidebarPanel("Worktrees").query()).toBeNull()
    await beginTour()
    // The first fixer opens its worktree: the panel is there to show it.
    await coachSays("Your turn. Open a terminal.", 20_000)
    await sidebarPanel("Worktrees").click()
    await expect.element(page.getByText("fix-tip").first()).toBeVisible()
    // Another project has none, as the setting says.
    await switchProject("storefront")
    await expect.poll(() => sidebarPanel("Worktrees").query()).toBeNull()
  })

  it("plays from the agent's start to both fixes merged, the person's terminal and answer included", async () => {
    await startTour()
    // It opens in Canvas, on the person's own agent.
    await coachSays("Your own agent. In a sandbox repo.")
    await expect.element(view("Canvas")).toBeChecked()

    // The lead opens a fixer for bug 1, which names itself.
    await coachSays("It put a fixer on bug 1.")
    await expect
      .poll(terminalTabNames, { timeout: 15_000 })
      .toEqual(expect.arrayContaining(["Tour lead", "Tip fixer"]))

    // The person opens a terminal: the tour starts their agent in it, as the second fixer.
    await coachSays("Your turn. Open a terminal.", 20_000)
    await expect.poll(() => coach().query()?.textContent ?? "").toContain("takes bug 2")
    await expect.element(page.getByText(/^Act 2, The team\./)).toBeInTheDocument()
    await newTerminalButton().click()

    // It asks the person in the Inbox, who answers; the tour waits on them.
    await coachSays("Your call.")
    await expect.element(page.getByText(/^Act 3, Your call\./)).toBeInTheDocument()
    await inboxRow(/Whole amounts/).click()
    const sheet = page.getByRole("dialog", { name: "Money fixer" })
    // Pressed once the card stands still: a click just after it moved is held back.
    const pick = sheet.getByRole("button", { name: /Always two decimals/ })
    await standsStill(pick)
    await pick.click()

    // Both fix their bug, each in its own worktree.
    await coachSays("Now they fix it. Each in its own worktree.")
    await sidebarPanel("Terminals").click()
    await expect
      .poll(terminalTabNames, { timeout: 15_000 })
      .toEqual(expect.arrayContaining(["Tour lead", "Tip fixer", "Money fixer"]))

    // The Files panel opens with the file in it, which the person opens: both fixes, merged.
    await coachSays("Both fixes, merged. Open the file.", 20_000)
    await expect.element(page.getByText(/^Act 4, The result\./)).toBeInTheDocument()
    await page.getByRole("treeitem", { name: /^split\.js,/ }).click()
    await coachSays("Two agents. One file. Merged live.")
    await expect.element(page.getByText(/\/ 100\) \/ people/).first()).toBeVisible()
    await expect.element(page.getByText(/toFixed\(2\)/).first()).toBeVisible()

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
