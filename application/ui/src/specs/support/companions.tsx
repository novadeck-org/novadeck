import { expect } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { openWorkspace, terminal, terminalTab } from "./workspace"

// Vocabulary for the companion taskbar along each terminal's bottom: its icons, their
// menus, and dragging them onto another terminal's bar or into a view's free space.

/**
 * Opens the showcase: project studio, where Codex in Build Studio has a plan, images and
 * files, Claude Code in Refactor auth has a plan, and Dev server has nothing to show.
 */
export const openShowcase = async (view: "grid" | "canvas" = "grid"): Promise<void> => {
  await openWorkspace(`/projects/studio/sessions/initial/${view}?demo=showcase`)
}

/** A terminal's taskbar, named after the agent whose things it shows. */
export const taskbar = (name: string): Locator =>
  terminal(name).getByRole("group", { name: /^What .+ showed you$/ })

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * An icon on a terminal's taskbar by how it reads, without what follows its first comma
 * unless given: `Plan: refactor-auth.md`, `2 images`, `hero.png, from Build Studio`.
 */
export const taskbarIcon = (name: string, label: string): Locator =>
  taskbar(name).getByRole("button", { name: new RegExp(`^${escaped(label)}(,|$)`) })

/** The pane beside a terminal that shows what its taskbar opens. */
export const companionPane = (name: string): Locator =>
  terminal(name).getByRole("region", { name: /^(What .+ showed you|Messages)$/ })

/** How the icons on a terminal's taskbar read, in order. */
export const taskbarIcons = (name: string): string[] =>
  taskbar(name)
    .getByRole("button")
    .elements()
    .map((icon) => icon.getAttribute("aria-label") ?? "")

/** Opens an icon's menu, as a right-click does. */
export const iconMenu = async (name: string, label: string): Promise<Locator> => {
  await taskbarIcon(name, label).click({ button: "right" })
  const menu = page.getByRole("menu")
  await expect.element(menu).toBeVisible()
  return menu
}

/** Picks an action from an icon's menu, such as `Close` or `Undock to its own window`. */
export const chooseFromIconMenu = async (
  name: string,
  label: string,
  action: string,
): Promise<void> => {
  const menu = await iconMenu(name, label)
  await menu.getByRole("menuitem", { name: action, exact: true }).click()
}

/** Picks one thing from a submenu of an icon's menu, such as a stack's `Open` and a file. */
export const chooseFromIconSubmenu = async (
  name: string,
  label: string,
  submenu: string,
  action: string,
): Promise<void> => {
  const menu = await iconMenu(name, label)
  await menu.getByRole("menuitem", { name: submenu, exact: true }).click()
  await page.getByRole("menuitem", { name: action, exact: true }).click()
}

/** Opens the menu of a window's sidebar tab, which a window undocked from a taskbar has too. */
export const windowMenu = async (name: string): Promise<Locator> => {
  await terminalTab(name).click({ button: "right" })
  const menu = page.getByRole("menu", { name: `${name} actions` })
  await expect.element(menu).toBeVisible()
  return menu
}

// A press, a drag past dnd-kit's 6px threshold in several moves, or in the one move
// that starts it, and a release.
const drag = async (
  source: Locator,
  target: Locator,
  at?: { x: number; y: number },
  steps = 12,
) => {
  await userEvent.dragAndDrop(source, target, {
    ...(at ? { targetPosition: at } : {}),
    steps,
    scroll: "none",
  })
}

/** Drags an icon off one terminal's taskbar and drops it on another terminal's. */
export const dragIconToBar = async (from: string, label: string, to: string): Promise<void> => {
  await drag(taskbarIcon(from, label), taskbar(to))
}

/**
 * Pulls one card out of a stacked icon's peek, as an icon of its own, and drops it on
 * another terminal's taskbar.
 */
export const dragCardToBar = async (
  from: string,
  stack: string,
  card: string,
  to: string,
): Promise<void> => {
  await taskbarIcon(from, stack).hover()
  const pulled = page.getByRole("button", { name: new RegExp(`^${escaped(card)}(,|$)`) })
  await expect.element(pulled).toBeVisible()
  await drag(pulled, taskbar(to))
}

const terminals = (): Element[] => page.getByRole("region", { name: / terminal$/ }).elements()

/** A point in `view`, relative to it, where no terminal window covers it. */
export const freeSpaceIn = (view: Locator): { x: number; y: number } => {
  const box = view.element().getBoundingClientRect()
  for (let y = box.height - 40; y > 40; y -= 40)
    for (let x = box.width - 40; x > 40; x -= 40) {
      const hit = document.elementFromPoint(box.left + x, box.top + y)
      if (hit && view.element().contains(hit) && !terminals().some((each) => each.contains(hit)))
        return { x, y }
    }
  throw new Error("No free space in the view")
}

/**
 * Drags an icon off a terminal's taskbar into a view's free space, which undocks it there:
 * in several moves, or in `one` move, which starts the drag and is released where it ends.
 */
export const dragIconToFreeSpace = async (
  from: string,
  label: string,
  view: Locator,
  { one = false }: { one?: boolean } = {},
): Promise<void> => {
  await drag(taskbarIcon(from, label), view, freeSpaceIn(view), one ? 1 : 12)
}

/**
 * Has the browser cancel the pointer, as it does when the system takes it over, once a
 * drag carries it over `target`: the drag that's under way gets a `pointercancel`, and
 * the release that follows ends nothing.
 */
export const cancelPointerOver = (target: Locator): void => {
  const moved = (pointer: PointerEvent): void => {
    const box = target.query()?.getBoundingClientRect()
    if (!box) return
    const { clientX: x, clientY: y } = pointer
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return
    window.removeEventListener("pointermove", moved, true)
    // After the app has followed this move.
    setTimeout(() => {
      const cancel = { pointerId: pointer.pointerId, pointerType: pointer.pointerType }
      window.dispatchEvent(new PointerEvent("pointercancel", { ...cancel, clientX: x, clientY: y }))
    })
  }
  window.addEventListener("pointermove", moved, true)
}
