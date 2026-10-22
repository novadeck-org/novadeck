import { describe as context, describe, expect, it } from "vitest"
import { page, userEvent } from "vitest/browser"

import { windowMenu } from "./support/companions"
import { openWorkspace, sidebarPanel, terminal, terminalTab } from "./support/workspace"

// The agents demo has the storefront's files in a Source panel. A file opened there lands in
// the session's project window: the person's, one at a time, named by the file.
const storefront = (view: "focus" | "grid" | "canvas"): string =>
  `/projects/storefront/sessions/initial/${view}?demo=agents`

const skipIntro = async (): Promise<void> => {
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
}

// A row's name is the file's, then who changed it when someone did.
const row = (name: string) =>
  page.getByRole("treeitem", { name: new RegExp(`^${name.replace(".", "\\.")}(,|$)`) })

const openSource = async (view: "focus" | "grid" | "canvas" = "grid"): Promise<void> => {
  await openWorkspace(storefront(view))
  await skipIntro()
  await sidebarPanel("Source").click()
  await expect.element(page.getByRole("tree", { name: "Project files" })).toBeVisible()
}

describe("The project window", () => {
  for (const view of ["focus", "grid", "canvas"] as const) {
    context(`in the ${view} view`, () => {
      it("opens on a double-click on a file in Source, and the sidebar lists it by the file's name", async () => {
        await openSource(view)

        await row("package.json").dblClick()

        await expect.element(terminal("package.json")).toBeVisible()
        await sidebarPanel("Terminals").click()
        await expect.element(terminalTab("package.json")).toBeVisible()
      })
    })
  }

  it("opens on Enter on a file too", async () => {
    await openSource()

    row("package.json").element().focus()
    await userEvent.keyboard("{Enter}")

    await expect.element(terminal("package.json")).toBeVisible()
  })

  it("leaves keyboard focus in the Source tree after Enter, so the next file opens from the keys", async () => {
    await openSource()
    const tree = page.getByRole("tree", { name: "Project files" }).element()

    row("package.json").element().focus()
    await userEvent.keyboard("{Enter}")
    await expect.element(terminal("package.json")).toBeVisible()
    expect(tree.contains(document.activeElement)).toBe(true)

    await userEvent.keyboard("{ArrowDown}{Enter}")
    await expect.element(terminal("package.json")).not.toBeInTheDocument()
    expect(tree.contains(document.activeElement)).toBe(true)
  })

  it("is re-pointed by the next file opened: still one window, with the new file in it", async () => {
    await openSource()
    await row("package.json").dblClick()
    await expect.element(terminal("package.json")).toBeVisible()

    await row("index.html").dblClick()

    await expect.element(terminal("index.html")).toBeVisible()
    await expect.element(terminal("package.json")).not.toBeInTheDocument()
    await sidebarPanel("Terminals").click()
    await expect.element(terminalTab("index.html")).toBeVisible()
    await expect.element(terminalTab("package.json")).not.toBeInTheDocument()
  })

  it("says under its name in the sidebar which folder the file is in, and nothing at the root", async () => {
    // The line under a tab's name, where a terminal's program goes.
    const line = (name: string) =>
      terminalTab(name)
        .element()
        .closest("[data-terminal-tab-id]")!
        .querySelector(".terminal-tab-process")!.textContent
    await openSource()
    await row("CartItem.tsx").dblClick()
    await expect.element(terminal("CartItem.tsx")).toBeVisible()
    await sidebarPanel("Terminals").click()
    await expect.element(terminalTab("CartItem.tsx")).toBeVisible()
    expect(line("CartItem.tsx")).toBe("src/cart")

    await sidebarPanel("Source").click()
    await row("package.json").dblClick()
    await sidebarPanel("Terminals").click()
    await expect.element(terminalTab("package.json")).toBeVisible()
    expect(line("package.json")).toBe("")
  })

  it("reads a Markdown file as a document labelled by the file's name", async () => {
    await openSource()

    await row("README.md").dblClick()

    await expect.element(terminal("README.md")).toBeVisible()
    await expect
      .element(terminal("README.md").getByRole("textbox", { name: "README.md" }))
      .toBeVisible()
  })

  it("holds back a file that looks like a secret behind the gate", async () => {
    await openSource()

    await row(".env.local").dblClick()

    const window = terminal(".env.local")
    await expect.element(window.getByRole("button", { name: "Show it" })).toBeVisible()
    await expect.element(window.getByRole("button", { name: "Copy path" })).toBeVisible()
  })

  it("is made again by the next open once it has been closed", async () => {
    await openSource()
    await row("package.json").dblClick()
    await expect.element(terminal("package.json")).toBeVisible()
    const menu = await (async () => {
      await sidebarPanel("Terminals").click()
      return windowMenu("package.json")
    })()
    await menu.getByRole("menuitem", { name: "Close" }).click()
    await expect.element(terminal("package.json")).not.toBeInTheDocument()

    await sidebarPanel("Source").click()
    await row("index.html").dblClick()

    await expect.element(terminal("index.html")).toBeVisible()
  })

  it("offers only Close in its menu: no rename, no dock back", async () => {
    await openSource()
    await row("package.json").dblClick()
    await sidebarPanel("Terminals").click()

    const menu = await windowMenu("package.json")

    await expect.element(menu.getByRole("menuitem", { name: "Close" })).toBeVisible()
    await expect.element(menu.getByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument()
    await expect.element(menu.getByRole("menuitem", { name: /^Dock in/ })).not.toBeInTheDocument()
  })
})
