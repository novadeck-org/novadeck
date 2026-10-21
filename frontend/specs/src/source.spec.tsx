import { describe as context, describe, expect, it } from "vitest"
import { page, userEvent } from "vitest/browser"

import { layoutSettled, openWorkspace, sidebarPanel } from "./support/workspace"

// The agents demo has a Source panel with the storefront's files. Specs run with reduced motion,
// so the demo's agents write nothing while a test looks, and a row's marks and chips hold still.
const agents = "/?demo=agents"
// The messages demo adds a team: @moth leads @crow.
const messages = "/?demo=messages"

const skipIntro = async (): Promise<void> => {
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
}

describe("The Source panel", () => {
  context("when the demo has a source to show", () => {
    it("opens from its toggle on the storefront's files, each with who changed it", async () => {
      await openWorkspace(agents)
      await skipIntro()

      await sidebarPanel("Source").click()

      await expect.element(page.getByRole("tree", { name: "Project files" })).toBeVisible()
      await expect
        .element(page.getByRole("treeitem", { name: /^Checkout\.tsx, modified, .*@crow/ }))
        .toHaveAccessibleName(/@moth/)
    })

    it("keeps one chip and a count on a row whose name has no room beside two", async () => {
      await openWorkspace(agents)
      await skipIntro()
      await sidebarPanel("Source").click()

      const select = page.getByRole("treeitem", { name: /^Checkout\.tsx,/ })
      await expect.element(select).toBeVisible()
      const row = select.element().closest(".source-row")!

      // Checkout.tsx was changed by two agents, and its row at the default width cannot hold
      // its name and two chips.
      expect(row.querySelectorAll(".source-chip")).toHaveLength(1)
      expect(row.querySelector(".source-more")?.textContent).toBe("+1")
    })
  })

  context("when the demo has a team whose members both worked here", () => {
    it("groups them in a squad track, and a click on the lead keeps both lit", async () => {
      await openWorkspace(messages)
      await skipIntro()
      await sidebarPanel("Source").click()

      const strip = page.getByRole("group", { name: "Light agents" })
      const squad = strip.getByRole("group", { name: "@moth's squad" })
      await expect.element(squad.getByRole("button", { name: "@moth" })).toBeVisible()
      await expect.element(squad.getByRole("button", { name: "@crow" })).toBeVisible()

      // Only @crow touched this test file, so it is dimmed while the selected agent is lit.
      const crowOnly = page.getByRole("treeitem", { name: /^Checkout\.test\.tsx,/ })
      const rowOf = (): Element | null => crowOnly.element().closest(".source-row")
      await expect.element(crowOnly).toBeVisible()
      await expect.poll(() => rowOf()?.getAttribute("data-dim")).toBe("true")

      await squad.getByRole("button", { name: "@moth" }).click()

      await expect
        .element(squad.getByRole("button", { name: "@moth" }))
        .toHaveAttribute("aria-pressed", "true")
      await expect
        .element(squad.getByRole("button", { name: "@crow" }))
        .toHaveAttribute("aria-pressed", "true")
      // The squad's crow lights its file, and what neither touched is still dimmed.
      await expect.poll(() => rowOf()?.getAttribute("data-dim")).toBe("false")
      await expect.poll(() => document.querySelector(".source-row[data-dim=true]")).not.toBeNull()
    })

    it("lets go of the kept agents on Escape after a mouse click, not sending it to the terminal", async () => {
      await openWorkspace(messages)
      await skipIntro()
      await sidebarPanel("Source").click()
      const strip = page.getByRole("group", { name: "Light agents" })
      const crow = strip.getByRole("button", { name: "@crow" })

      await crow.click()
      await expect.element(crow).toHaveAttribute("aria-pressed", "true")
      // Let the keyboard policy's next-frame focus handback run, as it would for a real click.
      await layoutSettled()
      await userEvent.keyboard("{Escape}")

      await expect.element(crow).toHaveAttribute("aria-pressed", "false")
      expect(
        strip.element().querySelectorAll("[aria-pressed=true], [aria-pressed=mixed]"),
      ).toHaveLength(0)
      // Focus stayed in the strip rather than going back to the terminal.
      expect(document.activeElement?.closest(".source-strip")).not.toBeNull()
    })
  })

  context("when the tree is as wide as the real fonts need", () => {
    const px = (value: string): number => Number.parseFloat(value) || 0

    // What a row asks for, with two chips and its name in full: the row's borders, the select's
    // padding and gaps, its parts at their own width, and the chips.
    const naturalWidth = (row: Element): number => {
      const select = row.querySelector<HTMLElement>(".source-row-select")!
      const [rowStyle, selectStyle] = [getComputedStyle(row), getComputedStyle(select)]
      const parts = Array.from(select.children) as HTMLElement[]
      return (
        px(rowStyle.borderLeftWidth) +
        px(rowStyle.borderRightWidth) +
        px(selectStyle.paddingLeft) +
        px(selectStyle.paddingRight) +
        px(selectStyle.columnGap) * (parts.length - 1) +
        parts.reduce(
          (sum, part) =>
            sum + (part.classList.contains("source-name") ? part.scrollWidth : part.offsetWidth),
          0,
        ) +
        row.querySelector<HTMLElement>(".source-chips")!.offsetWidth
      )
    }

    it("keeps two chips only where the name still reads in full, at every width around it", async () => {
      await openWorkspace(agents)
      await skipIntro()
      await sidebarPanel("Source").click()

      const tree = page.getByRole("tree", { name: "Project files" }).element() as HTMLElement
      const select = page.getByRole("treeitem", { name: /^Checkout\.tsx,/ })
      await expect.element(select).toBeVisible()
      const row = select.element().closest(".source-row")!
      const name = row.querySelector<HTMLElement>(".source-name")!
      const chips = (): number => row.querySelectorAll(".source-chip").length
      const resizeTo = async (width: number): Promise<void> => {
        tree.style.width = `${width}px`
        await expect.poll(() => tree.clientWidth).toBe(width)
        await layoutSettled()
      }

      // The width where this row, with both of its chips, needs no more than it has.
      await resizeTo(640)
      expect(chips()).toBe(2)
      const needed = Math.ceil(naturalWidth(row))

      // Two chips never cut the name, and one chip is kept wherever two would: sweeping across
      // the width where the real glyph widths and the estimate part ways, a few px at a time.
      const seen: { width: number; truncated: boolean; count: number }[] = []
      for (let width = needed - 14; width <= needed + 14; width += 2) {
        // eslint-disable-next-line no-await-in-loop -- One width after another.
        await resizeTo(width)
        seen.push({ width, truncated: name.scrollWidth > name.clientWidth, count: chips() })
      }
      expect(seen.filter(({ truncated }) => truncated)).toEqual([])
      expect(seen.filter(({ width, count }) => width >= needed + 2 && count !== 2)).toEqual([])
      expect(seen.filter(({ width, count }) => width < needed && count !== 1)).toEqual([])
    })
  })

  context("when the demo has no source", () => {
    it("has no Source toggle", async () => {
      await openWorkspace()

      await expect.element(sidebarPanel("Terminals")).toBeVisible()
      await expect.element(sidebarPanel("Source")).not.toBeInTheDocument()
    })
  })
})
