import { StrictMode } from "react"
import { expect } from "vitest"
import { cleanup, render } from "vitest-browser-react"
import { page, userEvent, type Locator } from "vitest/browser"

import { App } from "../../app/App"

// User-level vocabulary for behaviour specs. Specs describe what a person sees and
// does; only this module knows how that maps to accessible roles and names, so a
// reworked implementation that keeps the same UI needs changes here at most.
//
// Each spec file runs in its own page, but tests within a file share loaded modules:
// opening or reloading the workspace mounts a new <App />, it does not re-run module
// code. Keep workspace state owned by the App instance (for example a store created
// in a provider) so every test and every "reload" starts from the sample workspace.

const nextFrame = (): Promise<number> => new Promise(requestAnimationFrame)

/** Opens the app, optionally at a deep link such as `/projects/storefront/sessions/initial/grid`. */
export const openWorkspace = async (route?: string): Promise<void> => {
  // A same-page history entry below the app keeps an extra Back inside the test page.
  window.history.replaceState(null, "", "/")
  window.history.pushState(null, "", route === undefined ? "/" : `/#${route}`)
  await render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  // A link may open with a modal dialog, which hides the rest of the app.
  await expect.element(viewSwitcher().or(page.getByRole("dialog"))).toBeVisible()
  await layoutSettled()
}

/**
 * Waits until the current view has been laid out and stopped moving. Panels size
 * themselves after the first paint, so gestures aimed at a point wait for this.
 */
export const layoutSettled = async (): Promise<void> => {
  await expect
    .element(page.getByRole("status", { name: "Loading workspace" }))
    .not.toBeInTheDocument()
  const current = page.getByRole("region", {
    name: /^(focus|grid|canvas) view$/,
    includeHidden: true,
  })
  const measure = (): string => {
    const box = current.element().getBoundingClientRect()
    return box.width < 100 ? "unsized" : `${box.left},${box.top},${box.width},${box.height}`
  }
  let previous = ""
  await expect
    .poll(async () => {
      await nextFrame()
      const next = measure()
      const stable = next !== "unsized" && next === previous
      previous = next
      return stable
    })
    .toBe(true)
}

/**
 * Confirms that something does not happen: the element stays absent for several
 * rendered frames, so a reaction the app defers by a frame or two still fails the check,
 * and for at least `ms` milliseconds, for one it defers by a timer.
 */
export const expectStaysAbsent = async (
  locator: Locator,
  { frames = 10, ms = 0 }: { readonly frames?: number; readonly ms?: number } = {},
): Promise<void> => {
  let absent = 0
  let appeared = false
  const since = performance.now()
  await expect
    .poll(
      async () => {
        await nextFrame()
        appeared ||= locator.query() !== null
        absent += 1
        return appeared || (absent >= frames && performance.now() - since >= ms)
      },
      { message: `${locator.selector} appeared`, timeout: ms + 5000 },
    )
    .toBe(true)
  expect(appeared, `${locator.selector} appeared`).toBe(false)
}

/**
 * Notes how `read` sees `target` each time its `attribute` changes, from now on, and gives
 * back the notes when asked, which stops the noting: a state that passes quicker than a
 * check can poll for it, such as a change on its way, is still there to check after.
 */
export const recordChanges = <T,>(
  target: Locator,
  attribute: string,
  read: (element: Element) => T,
): (() => T[]) => {
  const element = target.element()
  const notes: T[] = []
  const observer = new MutationObserver(() => notes.push(read(element)))
  observer.observe(element, { attributes: true, attributeFilter: [attribute] })
  return () => {
    observer.disconnect()
    return notes
  }
}

/** Reloads the app at its current address: in-memory work starts over, stored preferences stay. */
export const reloadWorkspace = async (): Promise<void> => {
  const route = window.location.hash.replace(/^#/, "")
  await cleanup()
  await openWorkspace(route || undefined)
}

export const viewSwitcher = (): Locator =>
  page.getByRole("radiogroup", { name: "Workspace layout" })

export const view = (name: "Focus" | "Grid" | "Canvas"): Locator =>
  viewSwitcher().getByRole("radio", { name })

/** Clicks a view choice the way a person does: on its visible label. */
export const chooseView = async (name: "Focus" | "Grid" | "Canvas"): Promise<void> => {
  await viewSwitcher().getByText(name, { exact: true }).click()
  await expect.element(view(name)).toBeChecked()
  await layoutSettled()
}

export const sidebar = (): Locator => page.getByRole("complementary")

export const sidebarPanel = (name: "Terminals" | "Sessions"): Locator =>
  page.getByRole("radiogroup", { name: "Sidebar actions" }).getByRole("radio", { name })

/** A terminal as shown in the active Focus, Grid, or Canvas view. */
export const terminal = (name: string): Locator =>
  page.getByRole("region", { name: `${name} terminal` })

/** A terminal's entry in the Terminals sidebar. */
export const terminalTab = (name: string): Locator =>
  page.getByRole("button", { name: `Select ${name}`, exact: true })

/**
 * Puts keyboard focus on a terminal's sidebar tab, as Tab or a screen reader would. A mouse
 * click on a tab sends keyboard focus into the terminal, so this waits for that to settle
 * and then moves focus back onto the tab.
 */
export const focusTab = async (name: string): Promise<void> => {
  await terminalTab(name).click()
  await expect.element(commandInput(name)).toHaveFocus()
  terminalTab(name).element().focus()
  await expect.element(terminalTab(name)).toHaveFocus()
}

/** Puts keyboard focus on the checked view choice, as Tab does; a mouse click sends it to the terminal. */
export const focusViewChoice = async (): Promise<void> => {
  const choice = viewSwitcher()
    .getByRole("radio")
    .elements()
    .find((radio) => (radio as HTMLInputElement).checked)!
  ;(choice as HTMLElement).focus()
  await expect.poll(() => document.activeElement === choice).toBe(true)
}

/** Puts keyboard focus on the empty stage, outside every terminal and without navigating. */
export const focusStage = async (): Promise<void> => {
  const stage = document.querySelector<HTMLElement>("[data-workspace-viewport]")!
  stage.focus()
  await expect.poll(() => document.activeElement === stage).toBe(true)
}

/** The footer's note while navigating. */
export const navigateChip = (): Locator =>
  page.getByRole("status").filter({ hasText: "Navigating" })

/** Presses Shift+Esc, the way a person starts navigating the workspace. */
export const enterNavigateMode = async (): Promise<void> => {
  // A mouse click hands keyboard focus to the terminal a frame later, which would end the mode.
  await nextFrame()
  await nextFrame()
  await press("{Shift>}{Escape}{/Shift}")
  await expect.element(navigateChip()).toBeVisible()
}

/** Enter or Esc while navigating: the chip goes and typing focus returns to `name`. */
export const expectTypingIn = async (name: string): Promise<void> => {
  await expect.element(commandInput(name)).toHaveFocus()
  await expect.element(navigateChip()).not.toBeInTheDocument()
}

export const commandInput = (name: string): Locator =>
  page.getByRole("textbox", { name: `Command for ${name}` })

/** Terminal names in sidebar order. */
export const terminalTabNames = (): string[] =>
  page
    .getByRole("button", { name: /^Select / })
    .elements()
    .map((element) => element.getAttribute("aria-label")!.replace(/^Select /, ""))

export const expectSelected = async (name: string): Promise<void> => {
  await expect.element(terminalTab(name)).toHaveAttribute("aria-current", "true")
}

export const expectNothingSelected = async (): Promise<void> => {
  await expect
    .poll(() =>
      page
        .getByRole("button", { name: /^Select / })
        .elements()
        .filter((tab) => tab.getAttribute("aria-current") === "true"),
    )
    .toHaveLength(0)
}

/** Visible terminal counts such as `6 terminals`; hidden session entries use the same wording. */
export const visibleTerminalCounts = (): (string | null)[] =>
  page
    .getByText(/^\d+ terminals?$/)
    .elements()
    .filter((count) => count.checkVisibility({ visibilityProperty: true }))
    .map((count) => count.textContent)

/** Types keys through the real keyboard, e.g. `press("{Escape}")` or `press("{Control>}{Tab}{/Control}")`. */
export const press = (keys: string): Promise<void> => userEvent.keyboard(keys)

/** What `trigger`'s tooltip says, once the pointer has rested on it, as a person reads it. */
export const tooltipOf = async (trigger: Locator): Promise<string> => {
  await userEvent.hover(trigger)
  // The open tooltip is the trigger's own, never another still closing: the one its
  // description names, or, where something else describes it (a sortable handle), the
  // one its id pairs with.
  const shown = (): Element | null => {
    const element = trigger.element()
    const named = (element.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .find((each) => each?.matches('[data-scope="tooltip"][data-part="content"]'))
    const paired = element.id.endsWith(":trigger")
      ? document.getElementById(element.id.replace(/:trigger$/, ":content"))
      : null
    const open = named ?? paired
    return open?.getAttribute("data-state") === "open" ? open : null
  }
  await expect.poll(shown).not.toBeNull()
  return shown()!.textContent ?? ""
}

/** The platform modifier: Cmd on macOS, Ctrl elsewhere. Chromium on Linux/Windows uses Ctrl. */
export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * What a screen reader hears describe a terminal's tab, as aria-describedby resolves it,
 * less the instructions for reordering tabs every tab has; null when that's all.
 */
export const tabDescription = (name: string): string | null => {
  const tab = terminalTab(name).element()
  const ids = tab.getAttribute("aria-describedby")
  // Whatever aria-describedby names, a screen reader hears it instead of aria-description.
  if (!ids) return tab.getAttribute("aria-description")
  const parts = ids
    .split(/\s+/)
    // dnd-kit's own description, how to reorder the tab, is every tab's.
    .filter((id) => id && !id.startsWith("dnd-kit-description-"))
    .map((id) => document.getElementById(id)?.textContent ?? "")
  return parts.length ? parts.join(" ") : null
}
