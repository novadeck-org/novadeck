import { afterEach, describe as context, describe, expect, it } from "vitest"
import { page, userEvent } from "vitest/browser"

import { watchBarDrag } from "./support/bar-drag"
import { boxOf, canvasView, dragBackground, settled, viewBox } from "./support/canvas"
import {
  cancelPointerOver,
  chooseFromIconMenu,
  chooseFromIconSubmenu,
  companionPane,
  dragCardToBar,
  dragIconToBar,
  dragIconToFreeSpace,
  freeSpaceIn,
  iconMenu,
  openShowcase,
  taskbar,
  taskbarIcon,
  taskbarIcons,
  windowMenu,
} from "./support/companions"
import { gridView } from "./support/layouts"
import {
  chooseView,
  expectStaysAbsent,
  isMac,
  openWorkspace,
  terminal,
  terminalTab,
} from "./support/workspace"

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

  it("minimizes its pane back to the taskbar, for what was shown and for messages", async () => {
    await openShowcase()
    const pane = companionPane("Build Studio")
    const file = pane.getByText("src/content/projects.json", { exact: true })
    await expect.element(file).toBeVisible()

    await pane.getByRole("button", { name: "Minimize to the taskbar" }).click()

    await expect.element(pane).not.toBeInTheDocument()
    await taskbarIcon("Build Studio", "2 files").click()
    await expect.element(file).toBeVisible()

    await taskbarIcon("Build Studio", "Messages").click()
    await expect.element(pane.getByText("Pause all agents' messages")).toBeVisible()
    await pane.getByRole("button", { name: "Minimize to the taskbar" }).click()
    await expect.element(pane).not.toBeInTheDocument()
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

  it("closes what its pane shows, off the taskbar, and the pane with it", async () => {
    await openShowcase()
    const pane = companionPane("Build Studio")
    await expect.element(pane.getByText("src/content/projects.json", { exact: true })).toBeVisible()

    await pane.getByRole("button", { name: "Close projects.json", exact: true }).click()

    await expect.element(pane).not.toBeInTheDocument()
    await expect
      .poll(() => taskbarIcons("Build Studio"))
      .toEqual(["Plan: A home for Studio, new", "2 images", "brand-voice.md", "Messages"])
    // Focus goes back to the taskbar, not out of the page with the pane.
    expect(taskbar("Build Studio").element().contains(document.activeElement)).toBe(true)

    await taskbarIcon("Build Studio", "Messages").click()
    await pane.getByRole("button", { name: "Close Messages", exact: true }).click()
    await expect.element(pane).not.toBeInTheDocument()
    await expect.element(taskbarIcon("Build Studio", "Messages")).not.toBeInTheDocument()
  })
})

describe("The pane in Canvas", () => {
  it("hangs beside its terminal's window, not clipped by it", async () => {
    await openShowcase("canvas")
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    const pane = companionPane("Build Studio")
    await expect.element(pane).toBeVisible()
    // What's drawn just inside the pane's corner is the pane, not the board under it.
    await expect
      .poll(() => {
        const box = pane.element().getBoundingClientRect()
        return pane.element().contains(document.elementFromPoint(box.left + 24, box.top + 24))
      })
      .toBe(true)
  })

  it("belongs to its terminal's region, for assistive technology", async () => {
    await openShowcase("canvas")
    await expect.element(companionPane("Build Studio")).toBeVisible()
    const sheet = companionPane("Build Studio").element().closest(".plan-attached")!
    expect(terminal("Build Studio").element().contains(sheet)).toBe(false)
    expect(terminal("Build Studio").element().getAttribute("aria-owns")).toBe(sheet.id)
  })
})

describe("Escape in the pane", () => {
  for (const view of ["grid", "canvas"] as const)
    it(`hides it and puts focus back on the taskbar, in ${view === "grid" ? "Grid" : "Canvas"}`, async () => {
      await openShowcase(view)
      if (view === "grid") await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
      const pane = companionPane("Build Studio")
      await expect.element(pane).toBeVisible()
      // An open tooltip takes the first Escape to close itself: none is, with the pointer
      // on the pane's page.
      await userEvent.hover(pane)
      await expect.poll(() => document.querySelector('[role="tooltip"]')).toBeNull()
      pane.getByRole("button", { name: "Undock to its own window" }).element().focus()
      await userEvent.keyboard("{Escape}")
      await expect.poll(() => pane.query()).toBeNull()
      await expect
        .poll(() => taskbar("Build Studio").element().contains(document.activeElement))
        .toBe(true)
    })
})

describe("An image", () => {
  // Where the image is drawn in its viewer.
  const placeOf = (image: Element) => {
    const viewer = image.closest(".image-viewer")!.getBoundingClientRect()
    const box = image.getBoundingClientRect()
    return { x: box.left - viewer.left, y: box.top - viewer.top, width: box.width }
  }

  // The viewer takes the pointer: Grid's layout leaves its images none.
  const viewerOf = (pane: ReturnType<typeof companionPane>) =>
    pane.getByRole("region", { name: pane.getByRole("img").element().getAttribute("alt")! })

  it("zooms and moves under its header, which stays in view", async () => {
    await openShowcase()
    await taskbarIcon("Build Studio", "2 images").click()
    const pane = companionPane("Build Studio")
    const image = pane.getByRole("img")
    await expect.element(image).toBeVisible()
    await expect.poll(() => image.element().closest("[data-sized]")).not.toBeNull()
    // Fitted, it has no zoom to show.
    expect(pane.getByRole("button", { name: /^Zoomed to/ }).query()).toBeNull()

    await viewerOf(pane).dblClick()
    const zoom = pane.getByRole("button", { name: "Zoomed to 100%. Back to fit" })
    await expect.element(zoom).toBeVisible()
    await expect.poll(() => placeOf(image.element()).width).toBe(1600)

    const before = placeOf(image.element())
    const viewer = image.element().closest(".image-viewer")!
    viewer.dispatchEvent(new WheelEvent("wheel", { deltaX: 120, bubbles: true, cancelable: true }))
    await expect.poll(() => placeOf(image.element()).x).toBeLessThan(before.x)

    const area = viewer.parentElement!
    expect(area.scrollHeight).toBe(area.clientHeight)
    await expect
      .element(pane.getByText(image.element().getAttribute("alt")!, { exact: true }))
      .toBeInViewport()

    await zoom.click()
    await expect.poll(() => zoom.query()).toBeNull()
    expect(placeOf(image.element()).width).toBeLessThan(1600)
  })

  it("opens as it was left, zoomed and moved, after the pane showed something else", async () => {
    await openShowcase()
    await taskbarIcon("Build Studio", "2 images").click()
    const pane = companionPane("Build Studio")
    const image = pane.getByRole("img")
    await expect.element(image).toBeVisible()
    await expect.poll(() => image.element().closest("[data-sized]")).not.toBeNull()
    await viewerOf(pane).dblClick()
    await expect.poll(() => placeOf(image.element()).width).toBe(1600)
    const viewer = image.element().closest(".image-viewer")!
    viewer.dispatchEvent(new WheelEvent("wheel", { deltaX: 40, bubbles: true, cancelable: true }))
    const first = image.element()
    await expect.poll(() => placeOf(first).x).toBeLessThan(0)
    const left = placeOf(first)

    await taskbarIcon("Build Studio", "2 files").click()
    await expect
      .element(pane.getByRole("region", { name: "src/content/projects.json" }))
      .toBeVisible()
    await taskbarIcon("Build Studio", "2 images").click()

    await expect
      .element(pane.getByRole("button", { name: "Zoomed to 100%. Back to fit" }))
      .toBeVisible()
    const again = pane.getByRole("img").element()
    expect(again).not.toBe(first)
    await expect.poll(() => placeOf(again)).toEqual(left)
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

  it("opens where it was left, after the pane showed something else", async () => {
    // The showcase opens with Build Studio showing this file.
    await openShowcase()
    const pane = companionPane("Build Studio")
    const region = () => pane.getByRole("region", { name: "src/content/projects.json" })
    await expect.element(region()).toBeVisible()
    const lines = region().element()
    await expect.poll(() => lines.scrollHeight).toBeGreaterThan(lines.clientHeight + 40)
    lines.scrollTop = 40
    await expect.poll(() => lines.scrollTop).toBe(40)

    await taskbarIcon("Build Studio", "2 images").click()
    await expect.element(pane.getByRole("img")).toBeVisible()
    await taskbarIcon("Build Studio", "2 files").click()

    await expect.element(region()).toBeVisible()
    expect(region().element()).not.toBe(lines)
    expect(region().element().scrollTop).toBe(40)
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
    await expect.element(pane.getByRole("img")).toBeVisible()
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

describe("A plan whose edits can't be saved", () => {
  // Opens Build Studio's plan with the debug panel's fault in place, and types into it.
  const typeInto = async (fault: string): Promise<void> => {
    await openWorkspace(`/projects/studio/sessions/initial/grid?demo=showcase&planFault=${fault}`)
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    const content = (): HTMLElement | null =>
      companionPane("Build Studio").element().querySelector<HTMLElement>(".cm-content")
    await expect.poll(content).not.toBeNull()
    content()!.focus()
    await userEvent.keyboard("Draft ")
    await expect.poll(() => content()!.textContent).toContain("Draft ")
  }

  it("says why, keeps the edits, and offers to copy them or try again", async () => {
    await typeInto("folder")
    const pane = companionPane("Build Studio")
    await expect
      .element(
        pane.getByText(
          "Novadeck can't write to this plan's folder, so your edits can't be saved. Your edits are kept here until you close this plan.",
        ),
      )
      .toBeVisible()
    await expect.element(pane.getByRole("button", { name: "Copy my edits" })).toBeVisible()
    const notice = (): Element | null => pane.element().querySelector(".plan-notice")
    const before = notice()
    await pane.getByRole("button", { name: "Try saving again" }).click()
    // A new save was tried, which the folder refused again: the notice went and came back.
    await expect.poll(() => notice() !== null && notice() !== before).toBe(true)
    await expect.element(pane.getByText(/Novadeck can't write to this plan's folder/)).toBeVisible()
    expect(pane.element().querySelector(".cm-content")!.textContent).toContain("Draft ")
  })

  it("asks before closing the plan once it was placed elsewhere, copying the edits first", async () => {
    await typeInto("folder")
    await dragIconToBar("Build Studio", "Plan: A home for Studio", "Refactor auth")
    // Beside Refactor auth's own plan, which only hides; the placed one would be lost.
    await chooseFromIconMenu("Refactor auth", "2 plans", "Close 2 plans")
    const dialog = page.getByRole("alertdialog")
    await expect
      .element(dialog.getByText(/couldn't be saved, and closing it loses them/))
      .toBeVisible()
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect.element(dialog).not.toBeInTheDocument()
    const placed = taskbarIcon("Refactor auth", "Plan: A home for Studio")
    await expect.element(placed).toBeVisible()

    await chooseFromIconMenu("Refactor auth", "Plan: A home for Studio", "Close")
    await page.getByRole("button", { name: "Copy my edits and close" }).click()
    await expect.element(placed).not.toBeInTheDocument()
  })

  it("keeps saying a plan in its agent's messages is read-only", async () => {
    await openWorkspace("/projects/studio/sessions/initial/grid?demo=showcase&planFault=transcript")
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    await expect
      .element(companionPane("Build Studio").getByText(/^Read-only: this plan lives in Codex/))
      .toBeVisible()
  })

  it("only says a save is being tried again while a failure may pass", async () => {
    await typeInto("failing")
    const pane = companionPane("Build Studio")
    await expect.element(pane.getByText("Not saved yet. Trying again.")).toBeVisible()
  })
})

describe("Switching terminals in Focus", () => {
  it("finds a plan's pane as it was left, without building it again", async () => {
    await openShowcase("focus")
    await terminalTab("Build Studio").click()
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    const path = companionPane("Build Studio").getByText("plans/studio.md", { exact: true })
    await expect.element(path).toBeVisible()
    const scroll = path.element().closest(".plan-reader")!.querySelector(".plan-document-scroll")!
    await expect.poll(() => scroll.querySelector(".cm-editor")).not.toBeNull()
    const editor = scroll.querySelector(".cm-editor")
    await expect.poll(() => scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight + 100)
    // Reader input takes over from any saved-anchor restoration still measuring layout.
    scroll.dispatchEvent(new WheelEvent("wheel"))
    scroll.scrollTop = 100
    await expect.poll(() => scroll.scrollTop).toBe(100)

    await terminalTab("Refactor auth").click()
    // Past its fade out, parked.
    await expect.poll(() => scroll.closest("[data-parked]")).not.toBeNull()
    await terminalTab("Build Studio").click()

    await expect.element(path).toBeVisible()
    expect(scroll.isConnected).toBe(true)
    expect(scroll.querySelector(".cm-editor")).toBe(editor)
    expect(scroll.scrollTop).toBe(100)
  })
})

/** Waits for the page to draw `count` frames, in which the editor measures what changed. */
const frames = (count: number): Promise<void> =>
  new Promise((resolve) => {
    const next = (left: number): void => {
      if (left === 0) resolve()
      else requestAnimationFrame(() => next(left - 1))
    }
    next(count)
  })

/**
 * Keeps the page's main thread busy for `milliseconds`, in stretches longer than a frame, as a
 * loaded CI machine does: seen to end a restored scroll too early (Windows and Linux CI).
 */
const starving = new Set<ReturnType<typeof setInterval>>()
const starve = (milliseconds: number): void => {
  const timer = setInterval(() => {
    const end = performance.now() + 220
    while (performance.now() < end) {
      // Busy.
    }
  }, 260)
  starving.add(timer)
  setTimeout(() => {
    clearInterval(timer)
    starving.delete(timer)
  }, milliseconds)
}
/** Ends any stalls still running, so none reaches the next test. */
const calm = (): void => {
  for (const timer of starving) clearInterval(timer)
  starving.clear()
}

describe("Switching views", () => {
  afterEach(calm)

  it("keeps a restored plan at its saved line when its layout changes later", async () => {
    await openShowcase("grid")
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    const plan = (): HTMLElement =>
      companionPane("Build Studio").element().querySelector<HTMLElement>(".plan-document-scroll")!
    await expect.poll(() => plan()?.querySelector(".cm-content")).not.toBeNull()
    plan().dispatchEvent(new WheelEvent("wheel"))
    plan().scrollTop = 200
    await expect.poll(() => plan().scrollTop).toBe(200)
    const place = (): { line: string; top: number } => {
      const { top } = plan().getBoundingClientRect()
      const line = [...plan().querySelectorAll(".cm-line")].find(
        (each) => each.getBoundingClientRect().bottom > top + 1 && each.textContent?.trim(),
      )!
      return { line: line.textContent ?? "", top: line.getBoundingClientRect().top - top }
    }
    const saved = place()
    await chooseView("Focus")
    await terminalTab("Build Studio").click()
    await expect.poll(() => place().line).toBe(saved.line)
    // A layout change beyond the old finite restoration window, in the real editor.
    await new Promise((resolve) => setTimeout(resolve, 600))
    plan().querySelector<HTMLElement>(".cm-content")!.style.paddingTop = "150px"
    await expect.poll(() => place().line).toBe(saved.line)
    await expect.poll(() => Math.abs(place().top - saved.top)).toBeLessThan(1)

    // Once the reader takes over, a later layout change must not restore the old place.
    plan().style.overflowAnchor = "none"
    plan().dispatchEvent(new WheelEvent("wheel"))
    plan().scrollTop += 100
    const chosen = plan().scrollTop
    plan().querySelector<HTMLElement>(".cm-content")!.style.paddingTop = "250px"
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(plan().scrollTop).toBe(chosen)
  })

  it("opens a plan that wasn't scrolled at its very top again", async () => {
    await openShowcase("grid")
    await taskbarIcon("Refactor auth", "Plan: refactor-auth.md").click()
    const plan = (): HTMLElement | null | undefined =>
      companionPane("Refactor auth").element().querySelector<HTMLElement>(".plan-document-scroll")
    await expect.poll(() => plan()?.querySelector(".cm-content")).toBeTruthy()

    await chooseView("Focus")
    await chooseView("Grid")

    await expect.poll(() => plan()?.querySelector(".cm-content")).toBeTruthy()
    // Past the half second a restore may take.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(plan()!.scrollTop).toBe(0)
  })

  for (const busy of [true, false])
    it(`opens a plan's editor as it was left: scrolled, and with what can be undone${busy ? ", though the page is busy" : ""}`, async () => {
      await openShowcase("grid")
      await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
      const plan = (): HTMLElement =>
        companionPane("Build Studio").element().querySelector<HTMLElement>(".plan-document-scroll")!
      const content = (): HTMLElement => plan().querySelector<HTMLElement>(".cm-content")!
      await expect.poll(() => plan()?.querySelector(".cm-content")).not.toBeNull()
      content().focus()
      await userEvent.keyboard("Draft ")
      await expect.poll(() => content().textContent).toContain("Draft ")
      // Typing scrolls the caret into view, in the editor's next measure, back to the top
      // where a restored pane was elsewhere: a scroll set before it is undone by it.
      await frames(2)
      await expect.poll(() => plan().scrollHeight).toBeGreaterThan(plan().clientHeight + 200)
      plan().scrollTop = 200
      await expect.poll(() => plan().scrollTop).toBe(200)

      // The first line with words showing at the pane's top, and how far down it the top
      // is, as a share of the line, which holds however wide or zoomed the pane is.
      const place = (): { readonly line: string; readonly into: number } | undefined => {
        const { top } = plan().getBoundingClientRect()
        const line = [...plan().querySelectorAll(".cm-line")].find(
          (each) => each.getBoundingClientRect().bottom > top + 1 && each.textContent?.trim(),
        )
        if (!line) return undefined
        const box = line.getBoundingClientRect()
        return { line: line.textContent ?? "", into: (top - box.top) / box.height }
      }
      const reading = place()!
      expect(reading.line).toBeTruthy()
      const backAt = async (): Promise<void> => {
        await expect.poll(() => place()?.line).toBe(reading.line)
        await expect.poll(() => Math.abs(place()!.into - reading.into)).toBeLessThan(0.1)
      }

      await chooseView("Focus")
      await terminalTab("Build Studio").click()
      await backAt()
      // Canvas shows the pane zoomed, as it fits the board. A busy page draws few frames in
      // which the editor measures and the pane zooms: the place is kept all the same.
      if (busy) starve(1500)
      await chooseView("Canvas")
      await backAt()
      await chooseView("Grid")

      await expect
        .poll(() => companionPane("Build Studio").element().querySelector(".cm-content"))
        .not.toBeNull()
      await expect.poll(() => Math.abs(plan().scrollTop - 200)).toBeLessThan(24)
      content().focus()
      await userEvent.keyboard(isMac() ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}")
      await expect.poll(() => content().textContent).not.toContain("Draft ")

      // The undo reached the plan, not only the editor.
      await chooseView("Focus")
      await chooseView("Grid")
      await expect
        .poll(() => companionPane("Build Studio").element().querySelector(".cm-content"))
        .not.toBeNull()
      expect(content().textContent).not.toContain("Draft ")
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

describe("A stack's menu", () => {
  it("offers only what's done with all of it, and each of its things to open", async () => {
    await openShowcase()
    const menu = await iconMenu("Dev server", "7 files")
    const entries = menu
      .getByRole("menuitem")
      .elements()
      .map((entry) => entry.textContent)
    expect(entries).toEqual(["Open", "Move left", "Move right", "Close 7 files"])

    await menu.getByRole("menuitem", { name: "Close 7 files" }).click()

    await expect.element(taskbarIcon("Dev server", "7 files")).not.toBeInTheDocument()
  })
})

describe("Something that can't show", () => {
  it("says why, with its path to copy", async () => {
    await openShowcase()
    await chooseFromIconSubmenu("Dev server", "7 files", "Open", "notes.md")
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
    await chooseFromIconSubmenu("Dev server", "7 files", "Open", ".env.local")
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
        .element(taskbarIcon("Refactor auth", "hero.png, from @moth · Build Studio"))
        .toBeVisible()
      await expect.element(taskbarIcon("Build Studio", "about.png")).toBeVisible()
      await expectStaysAbsent(taskbarIcon("Build Studio", "2 images"))

      await chooseFromIconMenu(
        "Refactor auth",
        "hero.png, from @moth · Build Studio",
        "Send back to @moth · Build Studio",
      )
      await expect.element(taskbarIcon("Build Studio", "2 images")).toBeVisible()
      await expect
        .element(taskbarIcon("Refactor auth", "hero.png, from @moth · Build Studio"))
        .not.toBeInTheDocument()
    })
  })

  context("when the pointer is cancelled while an image is dragged over it", () => {
    it("stays where it was", async () => {
      await openShowcase()
      cancelPointerOver(taskbar("Refactor auth"))
      await dragCardToBar("Build Studio", "2 images", "hero.png", "Refactor auth")
      await expectStaysAbsent(taskbarIcon("Refactor auth", "hero.png, from @moth · Build Studio"))
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
        .element(taskbarIcon("Refactor auth", "about.png, from @moth · Build Studio"))
        .toBeVisible()
      await expect.element(taskbarIcon("Build Studio", "hero.png")).toBeVisible()
    })
  })

  context("when the messages are dragged onto it", () => {
    it("keeps them on their own terminal's taskbar", async () => {
      await openShowcase()
      await dragIconToBar("Build Studio", "Messages", "Refactor auth")
      await expect.element(taskbarIcon("Build Studio", "Messages")).toBeVisible()
      await expectStaysAbsent(taskbarIcon("Refactor auth", "Messages, from @moth · Build Studio"))
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
      watchBarDrag()
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
      watchBarDrag()
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
