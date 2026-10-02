import { describe as context, describe, expect, it } from "vitest"

import { boxOf, canvasView, dragBackground, viewBox } from "./support/canvas"
import {
  chooseFromIconMenu,
  companionPane,
  dragCardToBar,
  dragIconToBar,
  dragIconToFreeSpace,
  freeSpaceIn,
  openShowcase,
  taskbar,
  taskbarIcon,
  taskbarIcons,
  windowMenu,
} from "./support/companions"
import { gridView } from "./support/layouts"
import { expectStaysAbsent, terminal, terminalTab } from "./support/workspace"

describe("A terminal's taskbar", () => {
  it("shows its agent's plan, what it showed, and its messages, stacked by kind", async () => {
    await openShowcase()
    await expect.element(taskbarIcon("Build Studio", "Plan: A home for Studio")).toBeVisible()
    expect(taskbarIcons("Build Studio")).toEqual([
      "Plan: A home for Studio, new",
      "2 images",
      "2 files",
      "Messages",
    ])
  })

  // App bug: dnd-kit's Accessibility plugin writes `aria-pressed` (whether the icon is being
  // dragged) onto each icon, its sortable handle, over the app's own (whether the pane shows
  // it), so the icon reads as not pressed until React renders it again. Expected to fail
  // until that's fixed; then make it a plain `it`.
  it("marks the icon of what the pane shows as pressed", async () => {
    await openShowcase()
    await expect
      .element(
        companionPane("Build Studio").getByText("src/content/projects.json", { exact: true }),
      )
      .toBeVisible()
    await expect
      .element(taskbarIcon("Build Studio", "2 files"), { timeout: 1000 })
      .toHaveAttribute("aria-pressed", "true")
  })

  context("when an item is closed from its menu", () => {
    it("no longer shows the item", async () => {
      await openShowcase()
      await chooseFromIconMenu("Refactor auth", "Plan: refactor-auth.md", "Close")
      await expect
        .element(taskbarIcon("Refactor auth", "Plan: refactor-auth.md"))
        .not.toBeInTheDocument()
      await expect.element(taskbarIcon("Refactor auth", "Messages")).toBeVisible()
    })
  })
})

describe("Placing an item on another terminal's taskbar", () => {
  context("when an image is dragged onto it in Grid", () => {
    it("shows there, from its terminal, and goes back from its menu", async () => {
      await openShowcase()
      await dragCardToBar("Build Studio", "2 images", "hero.png", "Refactor auth")
      await expect
        .element(taskbarIcon("Refactor auth", "hero.png, from Build Studio"))
        .toBeVisible()
      await expect.element(taskbarIcon("Build Studio", "about.png")).toBeVisible()
      await expectStaysAbsent(taskbarIcon("Build Studio", "2 images"))

      await chooseFromIconMenu(
        "Refactor auth",
        "hero.png, from Build Studio",
        "Send back to Build Studio",
      )
      await expect.element(taskbarIcon("Build Studio", "2 images")).toBeVisible()
      await expect
        .element(taskbarIcon("Refactor auth", "hero.png, from Build Studio"))
        .not.toBeInTheDocument()
    })
  })

  context("when an image is dragged onto it in Canvas", () => {
    it("shows there, from its terminal", async () => {
      await openShowcase("canvas")
      // The terminals stand in one column: pan until Refactor auth's taskbar is in view.
      const bar = boxOf(taskbar("Refactor auth"))
      await dragBackground(freeSpaceIn(canvasView()), {
        x: 0,
        y: viewBox().height - 40 - (bar.top + bar.height),
      })
      await dragCardToBar("Build Studio", "2 images", "about.png", "Refactor auth")
      await expect
        .element(taskbarIcon("Refactor auth", "about.png, from Build Studio"))
        .toBeVisible()
      await expect.element(taskbarIcon("Build Studio", "hero.png")).toBeVisible()
    })
  })

  context("when the messages are dragged onto it", () => {
    it("keeps them on their own terminal's taskbar", async () => {
      await openShowcase()
      await dragIconToBar("Build Studio", "Messages", "Refactor auth")
      await expect.element(taskbarIcon("Build Studio", "Messages")).toBeVisible()
      await expectStaysAbsent(taskbarIcon("Refactor auth", "Messages, from Build Studio"))
      expect(taskbarIcons("Refactor auth")).toEqual([
        "Plan: refactor-auth.md, new",
        "Messages, 1 message waiting",
      ])
    })
  })
})

describe("Undocking an item into a window of its own", () => {
  context("when chosen from its icon's menu", () => {
    it("opens a window that docks back into its terminal from the window's menu", async () => {
      await openShowcase()
      await chooseFromIconMenu(
        "Build Studio",
        "Plan: A home for Studio",
        "Undock to its own window",
      )
      await expect.element(terminal("A home for Studio")).toBeVisible()
      await expect.element(terminalTab("A home for Studio")).toBeVisible()
      await expect
        .element(taskbarIcon("Build Studio", "Plan: A home for Studio"))
        .not.toBeInTheDocument()

      const menu = await windowMenu("A home for Studio")
      await menu.getByRole("menuitem", { name: "Dock in Build Studio" }).click()
      await expect.element(terminal("A home for Studio")).not.toBeInTheDocument()
      await expect.element(terminalTab("A home for Studio")).not.toBeInTheDocument()
      await expect.element(taskbarIcon("Build Studio", "Plan: A home for Studio")).toBeVisible()
      await expect
        .element(companionPane("Build Studio").getByText("plans/studio.md", { exact: true }))
        .toBeVisible()
    })
  })

  context("when dragged onto the Grid's free space", () => {
    it("opens a window there", async () => {
      await openShowcase()
      await dragIconToFreeSpace("Refactor auth", "Plan: refactor-auth.md", gridView())
      await expect.element(terminal("refactor-auth.md")).toBeVisible()
      await expect.element(terminalTab("refactor-auth.md")).toBeVisible()
      await expect
        .element(taskbarIcon("Refactor auth", "Plan: refactor-auth.md"))
        .not.toBeInTheDocument()
    })
  })
})
