import { afterEach } from "vitest"

import { companionPane, openShowcase, taskbarIcon } from "../support/companions"
import { terminal, terminalTab } from "../support/workspace"
import { describe, expect, it } from "../test"

// The debug panel's hold (demo-debug's pane-turns.ts): a pane coming into sight keeps its
// stand-in until the turns are let go.
const held = "data-pane-turns-held"
const hold = (): void => document.documentElement.setAttribute(held, "")
const letGo = (): void => document.documentElement.removeAttribute(held)

// And its sketches (demo-debug's pane-turns.ts again): a pane in sight a second is pictured
// as a sketch of its layout, where the desktop app takes a picture of it.
const sketched = "data-pane-pictures-sketched"
const sketch = (): void => document.documentElement.setAttribute(sketched, "")
// How long a pane is in sight before it's pictured, items' `firstMs`, with time to spare.
const picturedMs = 1_500

const standIn = (name: string) =>
  companionPane(name).getByRole("progressbar", { name: /^Opening / })

describe("A pane coming into sight", () => {
  afterEach(() => {
    letGo()
    document.documentElement.removeAttribute(sketched)
  })

  it("stands in as its icon and name in Grid until its turn, then shows what it holds", async () => {
    hold()
    await openShowcase("grid")
    const pane = companionPane("Build Studio")
    await expect.element(standIn("Build Studio")).toBeVisible()
    await expect.element(standIn("Build Studio")).toHaveTextContent("projects.json")
    await expect.element(pane.getByRole("tab", { name: "projects.json" })).not.toBeInTheDocument()

    letGo()
    await expect.element(standIn("Build Studio")).not.toBeInTheDocument()
    await expect.element(pane.getByRole("tab", { name: "projects.json" })).toBeVisible()
  })

  it("shows something else at once once it has had its turn", async () => {
    await openShowcase("grid")
    await expect
      .element(companionPane("Build Studio").getByRole("tab", { name: "projects.json" }))
      .toBeVisible()
    hold()
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    await expect
      .element(
        companionPane("Build Studio").getByRole("heading", { level: 2, name: "A home for Studio" }),
      )
      .toBeVisible()
    expect(standIn("Build Studio").elements()).toEqual([])
  })

  it("waits its turn in Focus as its terminal is switched back to, which shows at once", async () => {
    await openShowcase("focus")
    await terminalTab("Build Studio").click()
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    await expect.element(standIn("Build Studio")).not.toBeInTheDocument()

    await terminalTab("Refactor auth").click()
    await expect.element(terminal("Refactor auth")).toBeVisible()
    hold()
    await terminalTab("Build Studio").click()
    await expect.element(terminal("Build Studio")).toBeVisible()
    await expect.element(standIn("Build Studio")).toBeVisible()

    letGo()
    await expect.element(standIn("Build Studio")).not.toBeInTheDocument()
  })

  it("stands in as its picture where it was pictured at the size it is", async () => {
    sketch()
    await openShowcase("focus")
    await terminalTab("Build Studio").click()
    await expect
      .element(companionPane("Build Studio").getByRole("tab", { name: "projects.json" }))
      .toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, picturedMs))

    await terminalTab("Refactor auth").click()
    await expect.element(terminal("Refactor auth")).toBeVisible()
    hold()
    await terminalTab("Build Studio").click()
    await expect.element(standIn("Build Studio")).toBeVisible()
    const picture = standIn("Build Studio").element().querySelector("img.pane-stand-in-picture")
    expect(picture?.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/)
    await expect.element(standIn("Build Studio")).toHaveAttribute("data-pictured", "true")

    letGo()
    await expect.element(standIn("Build Studio")).not.toBeInTheDocument()
  })
})
