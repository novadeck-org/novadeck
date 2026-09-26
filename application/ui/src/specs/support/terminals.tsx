import { page, type Locator } from "vitest/browser"

import { sidebar, terminal, terminalTab } from "./workspace"

// Vocabulary for creating, renaming, hiding, minimizing, and closing terminals.

export const newTerminalButton = (): Locator =>
  sidebar().getByRole("button", { name: "New terminal" })

/** The name shown in a terminal's header. */
export const headerName = (name: string): Locator =>
  terminal(name).getByRole("heading", { name, exact: true })

export const headerRenameField = (name: string): Locator =>
  terminal(name).getByRole("textbox", { name: `Rename ${name}`, exact: true })

export const sidebarRenameField = (name: string): Locator =>
  sidebar().getByRole("textbox", { name: `Rename ${name}`, exact: true })

export const anyRenameField = (): Locator => page.getByRole("textbox", { name: /^Rename / })

/** A sidebar tab action such as `Rename Dev server` or `Close Dev server`. */
export const tabAction = (label: string): Locator =>
  sidebar().getByRole("button", { name: label, exact: true })

/** A terminal header action such as `Close Dev server` or `Minimize Dev server`. */
export const headerAction = (name: string, label: string): Locator =>
  terminal(name).getByRole("button", { name: label, exact: true })

export const hiddenTerminalTab = (name: string): Locator =>
  page.getByRole("button", { name: `Select ${name} (hidden)`, exact: true })

export const visibilityToggle = (name: string, action: "Hide" | "Show"): Locator =>
  sidebar().getByRole("button", { name: `${action} ${name} in Grid and Canvas`, exact: true })

/** The name text a person reads on a terminal's sidebar tab, hidden or not. */
export const tabName = (name: string): Locator =>
  terminalTab(name).or(hiddenTerminalTab(name)).getByText(name, { exact: true })

/**
 * The opacity a person sees on an element: its own opacity times every ancestor's.
 * Measure the leaf that is read (a name or heading) so a fade applied at any level counts.
 */
export const renderedOpacity = (leaf: Locator): number => {
  let opacity = 1
  for (let node: Element | null = leaf.element(); node; node = node.parentElement)
    opacity *= Number(getComputedStyle(node).opacity)
  return opacity
}
