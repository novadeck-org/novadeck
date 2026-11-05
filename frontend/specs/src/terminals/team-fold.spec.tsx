import { page, userEvent } from "vitest/browser"

import { windowMenu } from "../support/companions"
import { openMessagesDemo } from "../support/messages"
import { tabDescription, terminalTab } from "../support/workspace"
import { describe, expect, it } from "../test"

// In the messages demo, Checkout implementation leads Checkout review; Dev server is in no team.
const lead = "Checkout implementation"
const worker = "Checkout review"

// A tab found by its name in the page, as one folded out of the list is out of the
// accessibility tree too.
const tabOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-terminal-tab-id]")].find((tab) =>
    tab
      .querySelector(".sidebar-item-select")
      ?.getAttribute("aria-label")
      ?.startsWith(`Select ${name}`),
  )!
const foldOf = (name: string) => tabOf(name).getAttribute("data-team-fold")
const laidOut = (name: string) => tabOf(name).getClientRects().length > 0
const gutterElement = () => document.querySelector<HTMLElement>("[data-team-wire-gutter]")
const shape = () => document.querySelector<HTMLElement>(".team-wire-shape")
const marks = () => tabOf(lead).querySelector("[data-team-fold-marks]")

// Points at the gutter beside the lead's tab, as a person does on purpose, then away.
const pointBeside = async () => {
  await expect.poll(gutterElement).not.toBeNull()
  await userEvent.hover(gutterElement()!)
}
const pointAway = async () => userEvent.hover(terminalTab("Dev server"))

describe("Folding a lead's teammates out of the list", () => {
  it("leaves every teammate a top-level tab until the person folds", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await expect.poll(() => foldOf(worker)).toBe("shown")
    expect(laidOut(worker)).toBe(true)
    expect(foldOf(lead)).toBeNull()
    expect(marks()).toBeNull()
  })

  it("arms only from the gutter beside the lead's tab, never from the tab itself", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await userEvent.hover(terminalTab(lead))
    await expect.poll(() => shape()?.hasAttribute("data-armed")).toBe(false)
    expect(foldOf(worker)).toBe("shown")
    // The gutter ends where the tab begins.
    await expect.poll(gutterElement).not.toBeNull()
    const zone = gutterElement()!.getBoundingClientRect()
    expect(Math.round(zone.right)).toBe(Math.round(tabOf(lead).getBoundingClientRect().left))
    await pointBeside()
    await expect.poll(() => shape()?.hasAttribute("data-armed")).toBe(true)
    // Its teammates show what a click does.
    expect(foldOf(worker)).toBe("preview")
    await pointAway()
    await expect.poll(() => foldOf(worker)).toBe("shown")
  })

  it("folds them on a click there, keeping the lead's cursor and marking each teammate", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await pointBeside()
    await userEvent.click(gutterElement()!)
    await expect.poll(() => laidOut(worker)).toBe(false)
    expect(foldOf(worker)).toBe("away")
    // The wire is its lead's cursor alone; the hover waits for the pointer to leave.
    expect(document.querySelectorAll(".team-wire-tap")).toHaveLength(0)
    expect(document.querySelectorAll(".team-wire-cursor")).toHaveLength(1)
    expect(shape()?.hasAttribute("data-armed")).toBe(false)
    // What the folded teammate needs of the person still shows, on the lead.
    await expect.poll(marks).not.toBeNull()
    expect(marks()!.querySelector("[data-need='unblock']")).not.toBeNull()
    expect(tabDescription(lead)).toMatch(/Its teammate is folded out of this list$/)
  })

  it("shows them again from the gutter, which draws where they'd land, or from the marks", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await pointBeside()
    await userEvent.click(gutterElement()!)
    await expect.poll(() => laidOut(worker)).toBe(false)
    await pointAway()
    await pointBeside()
    await expect.poll(() => document.querySelectorAll(".team-wire-ghost-tap").length).toBe(1)
    await userEvent.click(gutterElement()!)
    await expect.poll(() => laidOut(worker)).toBe(true)
    expect(marks()).toBeNull()
    // And folded once more, the marks bring them back.
    await pointAway()
    await pointBeside()
    await userEvent.click(gutterElement()!)
    await expect.poll(marks).not.toBeNull()
    await userEvent.click(marks()!)
    await expect.poll(() => laidOut(worker)).toBe(true)
    // A click on the marks is the fold's, not a selection of the lead.
    expect(tabOf("Dev server").getAttribute("data-selected")).toBe("true")
  })

  it("folds and shows them from the lead's menu, the keyboard's way", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    let menu = await windowMenu(lead)
    await menu.getByRole("menuitem", { name: "Fold 1 teammate", exact: true }).click()
    await expect.poll(() => laidOut(worker)).toBe(false)
    menu = await windowMenu(lead)
    await menu.getByRole("menuitem", { name: "Show 1 teammate", exact: true }).click()
    await expect.poll(() => laidOut(worker)).toBe(true)
    // A teammate, and a terminal in no team, offer no fold.
    menu = await windowMenu(worker)
    await expect.element(menu.getByRole("menuitem", { name: /teammate/ })).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
  })

  it("shows a folded teammate in its place while the person is on it", async () => {
    await openMessagesDemo()
    await terminalTab(worker).click()
    const menu = await windowMenu(lead)
    await menu.getByRole("menuitem", { name: "Fold 1 teammate", exact: true }).click()
    // It's selected, so it stays until the person moves on.
    await expect.poll(() => foldOf(worker)).toBe("shown")
    expect(laidOut(worker)).toBe(true)
    await terminalTab("Dev server").click()
    await expect.poll(() => laidOut(worker)).toBe(false)
  })

  it("ends what pointing armed when the gutter goes away under the pointer", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await pointBeside()
    await expect.poll(() => foldOf(worker)).toBe("preview")
    // Hiding the sidebar takes the gutter away with no leave heard.
    await userEvent.keyboard("{Control>}{Shift>}e{/Shift}{/Control}")
    await expect.poll(gutterElement).toBeNull()
    // The pointer moves on to the header while it's hidden, then the sidebar comes back.
    await userEvent.hover(page.getByRole("radiogroup", { name: "Workspace layout" }))
    await userEvent.keyboard("{Control>}{Shift>}e{/Shift}{/Control}")
    await expect.poll(gutterElement).not.toBeNull()
    await expect.poll(() => foldOf(worker)).toBe("shown")
    expect(shape()?.hasAttribute("data-armed")).toBe(false)
  })

  it("unrolls a team once as it comes back, not again when its tabs mount later", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    const menu = await windowMenu(lead)
    await menu.getByRole("menuitem", { name: "Fold 1 teammate", exact: true }).click()
    await expect.poll(() => laidOut(worker)).toBe(false)
    const again = await windowMenu(lead)
    await again.getByRole("menuitem", { name: "Show 1 teammate", exact: true }).click()
    await expect.poll(() => foldOf(worker)).toBe("unfolding")
    await expect.poll(() => foldOf(worker), { timeout: 3000 }).toBe("shown")
  })
})
