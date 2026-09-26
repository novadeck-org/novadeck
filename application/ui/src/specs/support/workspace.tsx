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
  await render(<App />)
  // A link may open with a modal dialog, which hides the rest of the app.
  await expect.element(viewSwitcher().or(page.getByRole("dialog"))).toBeVisible()
  await layoutSettled()
}

/**
 * Waits until the current view has been laid out and stopped moving. Panels size
 * themselves after the first paint, so gestures aimed at a point wait for this.
 */
export const layoutSettled = async (): Promise<void> => {
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
 * rendered frames, so a reaction the app defers by a frame or two still fails the check.
 */
export const expectStaysAbsent = async (locator: Locator, frames = 10): Promise<void> => {
  let absent = 0
  let appeared = false
  await expect
    .poll(
      async () => {
        await nextFrame()
        appeared ||= locator.query() !== null
        absent += 1
        return !appeared && absent >= frames
      },
      { message: `${locator.selector} appeared` },
    )
    .toBe(true)
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

/** The platform modifier: Cmd on macOS, Ctrl elsewhere. Chromium on Linux/Windows uses Ctrl. */
export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform)
