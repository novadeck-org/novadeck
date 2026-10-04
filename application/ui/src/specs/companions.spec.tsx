import { describe as context, describe, expect, it } from "vitest"
import { page, userEvent } from "vitest/browser"

import { boxOf, canvasView, dragBackground, settled, viewBox } from "./support/canvas"
import {
  cancelPointerOver,
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

  it("takes something new as seen once the person has peeked at it", async () => {
    await openShowcase()
    const icon = taskbarIcon("Build Studio", "Plan: A home for Studio")
    await expect.element(icon).toHaveAttribute("data-state", "new")

    await userEvent.hover(icon)
    // The peek's card for it, still marked new while it shows.
    await expect.element(page.getByRole("button", { name: "A home for Studio, new" })).toBeVisible()
    await userEvent.unhover(icon)

    await expect.element(icon).toHaveAttribute("data-state", "seen")
    await expect
      .element(
        companionPane("Build Studio").getByText("src/content/projects.json", { exact: true }),
      )
      .toBeVisible()
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

describe("An image", () => {
  it("scrolls under its header, which stays in view", async () => {
    await openShowcase()
    await taskbarIcon("Build Studio", "2 images").click()
    const pane = companionPane("Build Studio")
    await pane.getByRole("button", { name: "100%", exact: true }).click()
    const area = pane.getByRole("img").element().parentElement!
    await expect.poll(() => area.scrollHeight).toBeGreaterThan(area.clientHeight)

    area.scrollTop = area.scrollHeight

    await expect.poll(() => area.scrollTop).toBeGreaterThan(0)
    const viewer = area.parentElement!
    expect(viewer.scrollHeight).toBe(viewer.clientHeight)
    await expect.element(pane.getByRole("button", { name: "Fit", exact: true })).toBeInViewport()
  })
})

describe("A file", () => {
  it("scrolls its lines under its header, which stays in view", async () => {
    // The showcase opens with Build Studio showing this file.
    await openShowcase()
    const pane = companionPane("Build Studio")
    const region = pane.getByRole("region", { name: "src/content/projects.json" })
    await expect.element(region).toBeVisible()
    const lines = region.element()
    await expect.poll(() => lines.scrollHeight).toBeGreaterThan(lines.clientHeight)

    lines.scrollTop = lines.scrollHeight

    await expect.poll(() => lines.scrollTop).toBeGreaterThan(0)
    await expect
      .element(pane.getByText("src/content/projects.json", { exact: true }))
      .toBeInViewport()
  })
})

describe("A viewer's header", () => {
  it("keeps the undock button in one place, beside a file, an image or a plan", async () => {
    // The showcase opens with Build Studio showing a file.
    await openShowcase()
    const pane = companionPane("Build Studio")
    const undock = pane.getByRole("button", { name: "Undock to its own window" })
    // Within its header, once the pane has its width: while the layout settles, a narrow
    // pane wraps the header and the button drops to its second line.
    const offset = (): number => {
      const button = undock.element()
      const header = button.closest(".artifact-meta")!
      return button.getBoundingClientRect().top - header.getBoundingClientRect().top
    }
    await expect
      .element(pane.getByRole("region", { name: "src/content/projects.json" }))
      .toBeVisible()
    const besideFile = await settled(offset)

    await taskbarIcon("Build Studio", "2 images").click()
    await expect.element(pane.getByRole("button", { name: "Fit", exact: true })).toBeVisible()
    expect(await settled(offset)).toBe(besideFile)

    // A plan has the same header across the pane, its outline and document under it.
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    await expect.element(pane.getByText("plans/studio.md", { exact: true })).toBeVisible()
    expect(await settled(offset)).toBe(besideFile)
  })
})

describe("A plan", () => {
  it("scrolls under its header, which stays in view", async () => {
    await openShowcase()
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    const pane = companionPane("Build Studio")
    const path = pane.getByText("plans/studio.md", { exact: true })
    await expect.element(path).toBeVisible()
    const scroll = path.element().closest(".plan-reader")!.querySelector(".plan-document-scroll")!
    await expect.poll(() => scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight)

    scroll.scrollTop = scroll.scrollHeight

    await expect.poll(() => scroll.scrollTop).toBeGreaterThan(0)
    await expect.element(path).toBeInViewport()
  })
})

/** The states of what a tab shows of its terminal's bar, in order. */
const tabKinds = (name: string): string[] =>
  [...terminalTab(name).element().querySelectorAll(".terminal-tab-kind")].map(
    (kind) => kind.getAttribute("data-state") ?? "",
  )

/** The opacity of a part of a terminal's tab, its actions or what its bar holds. */
const tabPartOpacity = (name: string, selector: string): number =>
  Number(
    getComputedStyle(terminalTab(name).element().closest(".terminal-tab")!.querySelector(selector)!)
      .opacity,
  )

describe("A terminal's tab", () => {
  it("shows what its bar holds, in the bar's order, marking what's new", async () => {
    await openShowcase()
    await expect.element(taskbarIcon("Build Studio", "Plan: A home for Studio")).toBeVisible()
    // The plan is new; the images, files and messages have been seen.
    await expect.poll(() => tabKinds("Build Studio")).toEqual(["new", "seen", "seen", "seen"])
    expect(tabKinds("Refactor auth").length).toBeGreaterThan(0)
  })

  it("shows what its bar holds on the name's line, above the actions", async () => {
    await openShowcase()
    const tab = terminalTab("Refactor auth").element().closest(".terminal-tab")!
    const kinds = tab.querySelector(".terminal-tab-kinds")!.getBoundingClientRect()
    const actions = tab.querySelector(".sidebar-item-actions")!.getBoundingClientRect()
    expect(kinds.bottom).toBeLessThanOrEqual(actions.top)
    expect(tabPartOpacity("Refactor auth", ".sidebar-item-actions")).toBe(1)
  })
})

describe("Something that can't show", () => {
  it("says why, with its path to copy", async () => {
    await openShowcase()
    await chooseFromIconMenu("Dev server", "7 files", "Open notes.md")
    const pane = companionPane("Dev server")
    await expect.element(pane.getByText("notes.md isn't there any more.")).toBeVisible()
    await expect.element(pane.getByRole("button", { name: "Copy path" })).toBeVisible()

    await taskbarIcon("Dev server", "screen-recording.png").click()
    await expect
      .element(pane.getByText("screen-recording.png is too large to preview (14.0 MB)."))
      .toBeVisible()

    // A plan in its agent's conversation has no file of its own to copy.
    await taskbarIcon("Dev server", "Subagent plan: old-migration.md").click()
    await expect.element(pane.getByText("old-migration.md is gone.")).toBeVisible()
    await expect.element(pane.getByRole("button", { name: "Copy path" })).not.toBeInTheDocument()
  })

  it("shows what may hold secrets once the person picks it, and never in a peek", async () => {
    await openShowcase()
    await taskbarIcon("Dev server", "7 files").hover()
    await expect.element(page.getByText("May hold secrets. Click to open.")).toBeVisible()
    await chooseFromIconMenu("Dev server", "7 files", "Open .env.local")
    const pane = companionPane("Dev server")
    await expect.element(pane.getByText("VITE_API_URL=http://localhost:8787")).toBeVisible()
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

  context("when the pointer is cancelled while an image is dragged over it", () => {
    it("stays where it was", async () => {
      await openShowcase()
      cancelPointerOver(taskbar("Refactor auth"))
      await dragCardToBar("Build Studio", "2 images", "hero.png", "Refactor auth")
      await expectStaysAbsent(taskbarIcon("Refactor auth", "hero.png, from Build Studio"))
      await expect.element(taskbarIcon("Build Studio", "2 images")).toBeVisible()
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

  context("when dropped on the Grid's free space by the move that starts the drag", () => {
    it("opens a window there", async () => {
      await openShowcase()
      await dragIconToFreeSpace("Refactor auth", "Plan: refactor-auth.md", gridView(), {
        one: true,
      })
      await expect.element(terminal("refactor-auth.md")).toBeVisible()
      await expect.element(terminalTab("refactor-auth.md")).toBeVisible()
      await expect
        .element(taskbarIcon("Refactor auth", "Plan: refactor-auth.md"))
        .not.toBeInTheDocument()
    })
  })
})
