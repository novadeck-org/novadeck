import { windowMenu } from "../support/companions"
import { openWorkspace, terminalTab } from "../support/workspace"
import { describe, expect, it } from "../test"

// The messages demo with a nested team: Checkout implementation (@moth) leads Checkout review
// (@crow), which leads Tests (@owl) in turn. Dev server is in no team.
const openNested = () => openWorkspace("/?demo=messages&nested=on")
const top = "Checkout implementation"
const sub = "Checkout review"
const deep = "Tests"

// A tab found by its name in the page, as one folded out of the list is out of the
// accessibility tree too.
const tabOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-terminal-tab-id]")].find((tab) =>
    tab
      .querySelector(".sidebar-item-select")
      ?.getAttribute("aria-label")
      ?.startsWith(`Select ${name}`),
  )!
const levelOf = (name: string) => tabOf(name).getAttribute("data-team-level")
const roleOf = (name: string) => tabOf(name).getAttribute("data-team")
const laidOut = (name: string) => tabOf(name).getClientRects().length > 0
const cursors = () =>
  [...document.querySelectorAll<HTMLElement>(".team-wire-cursor")].map((cursor) =>
    Math.round(cursor.getBoundingClientRect().left),
  )
const litShapes = () => document.querySelectorAll(".team-wire-shape[data-lit]").length

describe("A team inside another", () => {
  it("steps its tabs in a little, its lead's team's staying in line with every tab", async () => {
    await openNested()
    await expect.poll(() => levelOf(deep)).toBe("2")
    expect(levelOf(sub)).toBe("1")
    expect(levelOf(top)).toBeNull()
    expect(levelOf("Dev server")).toBeNull()
    const left = (name: string) => tabOf(name).getBoundingClientRect().left
    expect(Math.round(left(sub) - left(top))).toBe(0)
    expect(Math.round(left(deep) - left(top))).toBe(6)
  })

  it("runs its wire in a lane further in, its lead's cursor where its parent's tick ends", async () => {
    await openNested()
    await terminalTab("Dev server").click()
    await expect.poll(() => cursors().length).toBe(2)
    const [outer, inner] = cursors().toSorted((a, b) => a - b)
    expect(inner! - outer!).toBe(6)
  })

  it("lights a nested teammate's team and the way up through each lead above", async () => {
    await openNested()
    await terminalTab(deep).click()
    // Checkout review's team whole, and Checkout implementation's way down to Checkout review.
    await expect.poll(litShapes).toBe(2)
    expect(roleOf(deep)).toBe("worker")
    expect(roleOf(sub)).toBe("lead")
    expect(roleOf(top)).toBe("lead")
    expect(roleOf("Dev server")).toBeNull()
  })

  it("tints the whole tree whichever member is selected, the top lead's or a teammate's", async () => {
    await openNested()
    const tintedOn = async (name: string) => {
      await terminalTab(name).click()
      await expect.poll(() => roleOf(deep)).toBe("worker")
      expect(roleOf(sub)).toBe("lead")
      expect(roleOf(top)).toBe("lead")
      expect(roleOf("Dev server")).toBeNull()
    }
    await tintedOn(top)
    await tintedOn(sub)
    await tintedOn(deep)
  })

  it("folds with its parent's fold, and counts it on its lead's row", async () => {
    await openNested()
    await terminalTab("Dev server").click()
    const menu = await windowMenu(top)
    await menu.getByRole("menuitem", { name: "Fold 1 teammate", exact: true }).click()
    await expect.poll(() => laidOut(sub)).toBe(false)
    expect(laidOut(deep)).toBe(false)
    const row = tabOf(top).querySelector<HTMLElement>(".team-fold-row")!
    expect(row.textContent).toContain(sub)
    expect(row.querySelector(".team-fold-count")?.textContent).toBe("+1")
  })

  it("keeps the leads between in place while the person is on a folded nested teammate", async () => {
    await openNested()
    await terminalTab(deep).click()
    const menu = await windowMenu(top)
    await menu.getByRole("menuitem", { name: "Fold 1 teammate", exact: true }).click()
    await expect.poll(() => tabOf(top).querySelector(".team-fold-row")).not.toBeNull()
    expect(laidOut(deep)).toBe(true)
    expect(laidOut(sub)).toBe(true)
    await terminalTab("Dev server").click()
    await expect.poll(() => laidOut(deep)).toBe(false)
    expect(laidOut(sub)).toBe(false)
  })
})
