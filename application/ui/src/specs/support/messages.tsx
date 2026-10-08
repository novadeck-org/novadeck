import { expect } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { openWorkspace, terminal, terminalTab } from "./workspace"

// Vocabulary for agents' messages: the counts on terminals' tabs, a terminal's messages
// in its companion pane, and who named a terminal.

/** Opens the agents demo where its agents message each other, past the first-run welcome. */
export const openMessagesDemo = async (route = "/"): Promise<void> => {
  await openWorkspace(`${route}?demo=messages`)
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
}

/** Who named a terminal, as its tab's menu says in a line to read rather than choose. */
export const namedBy = async (name: string): Promise<string | null> => {
  const menu = await tabMenu(name)
  const line = menu.getByRole("menuitem").first()
  await expect.element(line).toBeVisible()
  const text = line.element().hasAttribute("data-disabled") ? line.element().textContent : null
  await userEvent.keyboard("{Escape}")
  await expect.element(menu).not.toBeInTheDocument()
  return text
}

/** The Messages button in a terminal's taskbar. */
export const messagesButton = (name: string): Locator =>
  terminal(name).getByRole("button", { name: /^Messages/ })

/** Opens a terminal's messages beside it. */
export const openMessages = async (name: string): Promise<Locator> => {
  await terminalTab(name).click()
  await messagesButton(name).click()
  const pane = terminal(name).getByRole("region", { name: "Messages", exact: true })
  await expect.element(pane).toBeVisible()
  return pane
}

/** A thread in a messages pane, by the peer's name and handle. */
export const thread = (pane: Locator, peer: string, handle: string): Locator =>
  pane.getByRole("region", { name: `Thread with ${peer} (${handle})` })

/** The messages of a thread, oldest first, as their items read. */
export const messageItems = (within: Locator): Locator => within.getByRole("listitem")

export const pauseSwitch = (pane: Locator): Locator =>
  pane.getByRole("switch", { name: "Pause all agents' messages" })

/** Opens a terminal tab's menu, as a right-click does. */
export const tabMenu = async (name: string): Promise<Locator> => {
  await terminalTab(name).click({ button: "right" })
  const menu = page.getByRole("menu", { name: `${name} actions` })
  await expect.element(menu).toBeVisible()
  return menu
}
