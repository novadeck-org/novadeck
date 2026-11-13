import { page, userEvent } from "vitest/browser"

import { chooseFromIconSubmenu, companionPane, openShowcase } from "../support/companions"
import { describe, expect, it } from "../test"

// The showcase's dev server holds a change in layers: the refactor of auth, two commits since
// main (a1c3f9e, then 7d02b4a) and an edit not committed.
const openChange = async () => {
  await openShowcase()
  await chooseFromIconSubmenu("Dev server", "8 changes", "Open", "Changes")
  const pane = companionPane("Dev server")
  await expect.element(pane.getByRole("listbox", { name: "Layers" })).toBeVisible()
  return pane
}

const layer = (pane: ReturnType<typeof companionPane>, name: RegExp) =>
  pane.getByRole("option", { name })
const file = (pane: ReturnType<typeof companionPane>, name: string) =>
  pane.getByRole("treeitem", { name, exact: true })

describe("A change's pane", () => {
  it("opens on its layers and the files all of them changed, every layer selected", async () => {
    const pane = await openChange()

    await expect.element(layer(pane, /^Uncommitted/)).toHaveAttribute("aria-selected", "true")
    await expect.element(layer(pane, /Test verifySession/)).toHaveAttribute("aria-selected", "true")
    await expect
      .element(layer(pane, /Check session expiry/))
      .toHaveAttribute("aria-selected", "true")
    await expect.element(pane.getByText("6 files · everything")).toBeVisible()
    await expect.element(file(pane, "cookies.ts")).toBeVisible()
    await expect.element(file(pane, "routes.ts")).toBeVisible()
  })

  it("keeps only the row clicked, moves to another clicked, and puts everything back on a second click", async () => {
    const pane = await openChange()

    await layer(pane, /Check session expiry/).click()
    await expect
      .element(layer(pane, /Check session expiry/))
      .toHaveAttribute("aria-selected", "true")
    await expect.element(layer(pane, /^Uncommitted/)).toHaveAttribute("aria-selected", "false")
    await expect.element(pane.getByText("3 files · a1c3f9e")).toBeVisible()
    await expect.element(file(pane, "cookies.ts")).not.toBeInTheDocument()
    await expect.element(pane.getByText(/^Click it again to see everything/)).toBeVisible()

    // Another row clicked is kept alone instead.
    await layer(pane, /Test verifySession/).click()
    await expect.element(layer(pane, /Test verifySession/)).toHaveAttribute("aria-selected", "true")
    await expect
      .element(layer(pane, /Check session expiry/))
      .toHaveAttribute("aria-selected", "false")
    await expect.element(layer(pane, /^Uncommitted/)).toHaveAttribute("aria-selected", "false")
    await expect.element(pane.getByText(/· 7d02b4a$/)).toBeVisible()

    // Clicking the row kept alone puts everything back.
    await layer(pane, /Test verifySession/).click()
    await expect.element(pane.getByText("6 files · everything")).toBeVisible()
    await expect.element(layer(pane, /^Uncommitted/)).toHaveAttribute("aria-selected", "true")
    await expect.element(pane.getByText(/^Click a commit to see only it/)).toBeVisible()
  })

  it("unfolds what a file changed, one file at a time, then opens it, steps and goes back", async () => {
    const pane = await openChange()

    // One click unfolds the facts of a file under its row.
    await file(pane, "cookies.ts").click()
    await expect.element(file(pane, "cookies.ts")).toHaveAttribute("aria-expanded", "true")
    await expect.element(pane.getByText("in cookieMaxAge 7 → 30").first()).toBeVisible()
    await file(pane, "Header.tsx").click()
    await expect.element(file(pane, "cookies.ts")).toHaveAttribute("aria-expanded", "false")
    await expect.element(file(pane, "Header.tsx")).toHaveAttribute("aria-expanded", "true")
    await expect.element(pane.getByText(/4 re-indented/).first()).toBeVisible()

    // A double click opens it: a heading with the file, and where it is among the files.
    await file(pane, "cookies.ts").dblClick()
    await expect.element(pane.getByRole("button", { name: "Back to the files" })).toBeVisible()
    await expect.element(pane.getByText("1 of 6")).toBeVisible()
    await expect
      .element(pane.getByText("export const cookieMaxAge = 30 * day", { exact: false }))
      .toBeVisible()
    await expect.element(pane.getByText("line 4")).toBeVisible()

    // The arrows step through the selection's files (J and K do, which the viewer's own
    // tests drive).
    await pane.getByRole("button", { name: "Next file" }).click()
    await expect.element(pane.getByText("2 of 6")).toBeVisible()
    await pane.getByRole("button", { name: "Previous file" }).click()
    await expect.element(pane.getByText("1 of 6")).toBeVisible()

    // Back goes to the files, where the opened file is gray, as a read row is.
    await pane.getByRole("button", { name: "Back to the files" }).click()
    await expect.element(pane.getByRole("listbox", { name: "Layers" })).toBeVisible()
    await expect
      .element(page.getByRole("treeitem", { name: "cookies.ts", exact: true }))
      .toBeVisible()
    expect(
      pane
        .getByRole("treeitem", { name: "cookies.ts", exact: true })
        .element()
        .closest(".diff-file")
        ?.getAttribute("data-read"),
    ).toBe("true")
  })

  it("takes J, K and Escape in a file, in a grid where its pane covers the terminal", async () => {
    const pane = await openChange()

    await file(pane, "cookies.ts").dblClick()
    await expect.element(pane.getByText("1 of 6")).toBeVisible()
    await userEvent.keyboard("j")
    await expect.element(pane.getByText("2 of 6")).toBeVisible()
    await userEvent.keyboard("k")
    await expect.element(pane.getByText("1 of 6")).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect.element(pane.getByRole("listbox", { name: "Layers" })).toBeVisible()
  })

  it("opens a file on Enter, and goes back with the back button", async () => {
    const pane = await openChange()

    file(pane, "routes.ts").element().focus()
    await userEvent.keyboard("{Enter}")
    await expect.element(pane.getByText("5 of 6")).toBeVisible()
    await expect.element(pane.getByText(/more changed lines/).first()).toBeVisible()

    await pane.getByRole("button", { name: "Back to the files" }).click()
    await expect.element(pane.getByRole("listbox", { name: "Layers" })).toBeVisible()
  })
})
