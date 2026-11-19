import { afterEach, beforeEach } from "vitest"

import { companionPane, openShowcase } from "../support/companions"
import { failFetches } from "../support/fetches"
import { terminal } from "../support/workspace"
import { describe, expect, it } from "../test"

// The data tree's code, which loads when a data file first shows.
const dataTree = "**/items/src/kinds/file/DataViewer.tsx*"

// What the page reported of its failed loads: the app puts each on the page's `error` event,
// for the desktop app's log, which the specs would otherwise count as uncaught.
let reported: unknown[] = []
const keep = (event: ErrorEvent): void => {
  event.preventDefault()
  reported.push(event.error)
}
beforeEach(() => {
  reported = []
  window.addEventListener("error", keep)
})
afterEach(async () => {
  window.removeEventListener("error", keep)
  await failFetches(dataTree, false)
})

// The showcase opens with Build Studio's pane showing projects.json, a data file, as a tree.
describe("A pane view whose code fails to load", () => {
  it("says so in its pane, keeps the app up, and loads on Retry", async () => {
    await failFetches(dataTree, true)
    await openShowcase()
    const pane = companionPane("Build Studio")

    const failed = pane.getByRole("alert")
    await expect.element(failed.getByText("Couldn't load this view.")).toBeVisible()
    await expect.element(pane.getByRole("tab", { name: "projects.json" })).toBeVisible()
    await expect.element(terminal("Refactor auth")).toBeVisible()
    await expect.element(terminal("Dev server")).toBeVisible()
    expect(document.body.textContent).not.toContain("Novadeck ran into an error")
    expect(reported).toHaveLength(1)

    await failFetches(dataTree, false)
    await failed.getByRole("button", { name: "Retry" }).click()

    await expect
      .element(pane.getByRole("tree", { name: "src/content/projects.json" }))
      .toBeVisible()
    expect(failed.query()).toBeNull()
  })
})
