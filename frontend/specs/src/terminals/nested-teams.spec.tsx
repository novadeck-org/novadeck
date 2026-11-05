import { userEvent } from "vitest/browser"

import { windowMenu } from "../support/companions"
import { openWorkspace, terminalTab } from "../support/workspace"
import { describe, expect, it } from "../test"

// The messages demo with a nested team: Checkout implementation (@moth) leads Tests (@owl)
// and Runtime, and Tests leads Checkout review (@crow), which needs permission. Dev server is
// in no team.
const openNested = () => openWorkspace("/?demo=messages&nested=on")
const top = "Checkout implementation"
const sub = "Tests"
const deep = "Checkout review"
const sibling = "Runtime"

// A tab found by its name in the page, as one folded out of the list is out of the
// accessibility tree too.
const tabOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-terminal-tab-id]")].find((tab) =>
    tab
      .querySelector(".sidebar-item-select")
      ?.getAttribute("aria-label")
      ?.startsWith(`Select ${name}`),
  )!
const idOf = (name: string) => tabOf(name).getAttribute("data-terminal-tab-id")!
const levelOf = (name: string) => tabOf(name).getAttribute("data-team-level")
const roleOf = (name: string) => tabOf(name).getAttribute("data-team")
const laidOut = (name: string) => tabOf(name).getClientRects().length > 0
const cursors = () =>
  [...document.querySelectorAll<HTMLElement>(".team-wire-cursor")].map((cursor) =>
    Math.round(cursor.getBoundingClientRect().left),
  )
const litTaps = () => document.querySelectorAll(".team-wire-shape[data-lit] .team-wire-tap").length
const rowOf = (lead: string, name: string) =>
  tabOf(lead).querySelector<HTMLElement>(`[data-team-fold-row="${idOf(name)}"]`)
const foldTop = async () => {
  const menu = await windowMenu(top)
  await menu.getByRole("menuitem", { name: "Fold 3 teammates", exact: true }).click()
}

describe("A team inside another", () => {
  it("steps its tabs in a little, its lead's team's staying in line with every tab", async () => {
    await openNested()
    await expect.poll(() => levelOf(deep)).toBe("2")
    expect(levelOf(sub)).toBe("1")
    expect(levelOf(top)).toBeNull()
    const left = (name: string) => tabOf(name).getBoundingClientRect().left
    expect(Math.round(left(sub) - left(top))).toBe(0)
    expect(Math.round(left(sibling) - left(top))).toBe(0)
    expect(Math.round(left(deep) - left(top))).toBe(6)
  })

  it("runs its wire in a lane further in than its lead's team's", async () => {
    await openNested()
    await terminalTab("Dev server").click()
    await expect.poll(() => cursors().length).toBe(2)
    const [outer, inner] = cursors().toSorted((a, b) => a - b)
    expect(inner! - outer!).toBe(6)
  })

  it("lights a nested teammate's team whole, and only the way up through the lead above", async () => {
    await openNested()
    await terminalTab(deep).click()
    // Tests' team's one tick, and the top lead's tick into Tests, not into Runtime.
    await expect.poll(litTaps).toBe(2)
    await terminalTab(sub).click()
    // Both of Tests' teams whole: its own (1) and the top lead's (2).
    await expect.poll(litTaps).toBe(3)
  })

  it("tints the whole tree whichever member is selected, the top lead's or a teammate's", async () => {
    await openNested()
    const tintedOn = async (name: string) => {
      await terminalTab(name).click()
      await expect.poll(() => roleOf(deep)).toBe("worker")
      expect(roleOf(sub)).toBe("lead")
      expect(roleOf(top)).toBe("lead")
      expect(roleOf(sibling)).toBe("worker")
      expect(roleOf("Dev server")).toBeNull()
    }
    await tintedOn(top)
    await tintedOn(sibling)
    await tintedOn(deep)
  })

  it("folds with its parent's fold, counted and with what it needs of the person on its lead's row", async () => {
    await openNested()
    await terminalTab("Dev server").click()
    await foldTop()
    await expect.poll(() => laidOut(sub)).toBe(false)
    expect(laidOut(deep)).toBe(false)
    expect(laidOut(sibling)).toBe(false)
    const row = rowOf(top, sub)!
    expect(row.querySelector(".team-fold-count")?.textContent).toBe("+1")
    // Checkout review, folded away under Tests, needs permission: Tests' row says so.
    const need = row.querySelector<HTMLElement>(".team-fold-needs [data-need='unblock']")!
    expect(getComputedStyle(need).display).not.toBe("none")
  })

  it("shows a nested lead's own team while the person is on it under a fold", async () => {
    await openNested()
    await terminalTab("Dev server").click()
    await foldTop()
    await expect.poll(() => rowOf(top, sub)).not.toBeNull()
    await userEvent.click(rowOf(top, sub)!)
    await expect.poll(() => laidOut(sub)).toBe(true)
    expect(laidOut(deep)).toBe(true)
    expect(laidOut(sibling)).toBe(false)
  })

  it("keeps the leads between in place while the person is on a folded nested teammate", async () => {
    await openNested()
    await terminalTab(deep).click()
    await foldTop()
    await expect.poll(() => rowOf(top, sub)).not.toBeNull()
    expect(laidOut(deep)).toBe(true)
    expect(laidOut(sub)).toBe(true)
    await terminalTab("Dev server").click()
    await expect.poll(() => laidOut(deep)).toBe(false)
    expect(laidOut(sub)).toBe(false)
  })

  it("fades back in with its parent's unfold, as its parent's wire does", async () => {
    await openNested()
    await terminalTab("Dev server").click()
    await foldTop()
    await expect.poll(() => laidOut(sub)).toBe(false)
    const menu = await windowMenu(top)
    await menu.getByRole("menuitem", { name: "Show 3 teammates", exact: true }).click()
    await expect.poll(() => laidOut(deep)).toBe(true)
    // The top team's wire and the nested team's both come back fading in.
    await expect
      .poll(() => document.querySelectorAll(".team-wire-shape[data-unfolding]").length)
      .toBe(2)
  })
})
