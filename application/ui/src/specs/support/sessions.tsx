import { expect } from "vitest"
import { page, type Locator } from "vitest/browser"

import { isMac, press } from "./workspace"

// Vocabulary for projects, saved sessions, and navigation through the address bar.

export const workspaceSwitcher = (): Locator =>
  page.getByRole("button", { name: "Switch workspace", exact: true })

/** Chooses a project from the Switch workspace menu, e.g. `switchProject("api-service")`. */
export const switchProject = async (name: string): Promise<void> => {
  await workspaceSwitcher().click()
  await page
    .getByRole("dialog", { name: "Switch workspace" })
    .getByRole("button", { name: new RegExp(`^${name} `) })
    .click()
  await expect.element(workspaceSwitcher()).toHaveTextContent(name)
}

export const savedSessions = (): Locator => page.getByRole("list", { name: "Saved sessions" })

/** A session's entry in the Sessions sidebar. */
export const savedSession = (name: string): Locator =>
  savedSessions().getByRole("button", { name: `Open ${name}`, exact: true })

/** The name of the session marked current in the Sessions sidebar. */
export const currentSessionName = async (): Promise<string> => {
  const current = (): Element | undefined =>
    savedSessions()
      .getByRole("button")
      .elements()
      .find((entry) => entry.getAttribute("aria-current") === "true")
  await expect.poll(current).toBeDefined()
  return current()!
    .getAttribute("aria-label")!
    .replace(/^Open /, "")
}

/**
 * The name of a session just created while `original` was current: waits until the
 * Sessions sidebar marks a different entry current.
 */
export const newSessionName = async (original: string): Promise<string> => {
  await expect.poll(currentSessionName).not.toBe(original)
  return currentSessionName()
}

export const expectCurrentSession = async (name: string): Promise<void> => {
  await expect.element(savedSession(name)).toHaveAttribute("aria-current", "true")
}

export const emptyWorkspace = (): Locator =>
  page.getByRole("heading", { name: "No terminals open" })

/** Presses the new-session shortcut: Cmd+Shift+N on macOS, Ctrl+Shift+N elsewhere. */
export const pressNewSession = (): Promise<void> => {
  const modifier = isMac() ? "Meta" : "Control"
  return press(`{${modifier}>}{Shift>}N{/Shift}{/${modifier}}`)
}

/** Types a command into a terminal and runs it. */
export const run = async (input: Locator, command: string): Promise<void> => {
  await input.fill(command)
  await input.click()
  await press("{Enter}")
  await expect.element(input).toHaveValue("")
}

/** The current address as a workspace route, e.g. `/projects/storefront/sessions/initial/focus?terminal=01`. */
export const currentRoute = (): string => window.location.hash.replace(/^#/, "")

/** Follows a link inside the running app, as when a person edits the address bar. */
export const visit = (route: string): void => {
  window.location.hash = route
}
