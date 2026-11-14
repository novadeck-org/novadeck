import { afterEach } from "vitest"

import { companionPane, openShowcase, taskbarIcon } from "../support/companions"
import { terminal, terminalTab } from "../support/workspace"
import { describe, expect, it } from "../test"

// The debug panel's hold (demo-debug's pane-turns.ts): a pane coming into sight keeps its
// stand-in until the turns are let go.
const held = "data-pane-turns-held"
const hold = (): void => document.documentElement.setAttribute(held, "")
const letGo = (): void => document.documentElement.removeAttribute(held)

const standIn = (name: string) =>
  companionPane(name).getByRole("progressbar", { name: /^Opening / })

describe("A pane coming into sight", () => {
  afterEach(letGo)

  it("stands in as its icon and name in Grid until its turn, then shows what it holds", async () => {
    hold()
    await openShowcase("grid")
    const pane = companionPane("Build Studio")
    await expect.element(standIn("Build Studio")).toBeVisible()
    await expect.element(standIn("Build Studio")).toHaveTextContent("projects.json")
    await expect
      .element(pane.getByText("src/content/projects.json", { exact: true }))
      .not.toBeInTheDocument()

    letGo()
    await expect.element(standIn("Build Studio")).not.toBeInTheDocument()
    await expect.element(pane.getByText("src/content/projects.json", { exact: true })).toBeVisible()
  })

  it("shows something else at once once it has had its turn", async () => {
    await openShowcase("grid")
    await expect
      .element(
        companionPane("Build Studio").getByText("src/content/projects.json", { exact: true }),
      )
      .toBeVisible()
    hold()
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    await expect
      .element(companionPane("Build Studio").getByText("plans/studio.md", { exact: true }))
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
})
