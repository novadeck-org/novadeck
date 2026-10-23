import { expect } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { labelled, openWorkspace, terminal, terminalTab } from "./workspace"

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

/** The rows of a messages pane's list, in its order. */
export const conversationRows = (pane: Locator): Locator =>
  pane.getByRole("list", { name: "Conversations" }).getByRole("button")

/** A row of a messages pane's list, by its terminal's name and handle, or as "You", which
 * its name goes on from to say what its corner says. */
export const conversationRow = (pane: Locator, label: string): Locator =>
  pane.getByRole("list", { name: "Conversations" }).getByRole("button", {
    name: new RegExp(
      `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, (asks you|not delivered|unread|last at)`,
    ),
  })

/** Opens a conversation from a messages pane's list; returns its chat. */
export const openConversation = async (pane: Locator, label: string): Promise<Locator> => {
  await conversationRow(pane, label).click()
  const chat = pane.getByRole("list", { name: /^Messages with / })
  await expect.element(chat).toBeVisible()
  return chat
}

/** The entries of a chat, oldest first, as their items read: times, lines and messages. */
export const messageItems = (within: Locator): Locator => within.getByRole("listitem")

/** The messages alone of a chat, oldest first. */
export const bubbles = (chat: Locator): Element[] => [
  ...chat.element().querySelectorAll(".mail-bubble-row"),
]

export const pauseSwitch = (pane: Locator): Locator =>
  pane.getByRole("switch", { name: "Pause all agents' messages" })

/** Opens a terminal tab's menu, as a right-click does. */
export const tabMenu = async (name: string): Promise<Locator> => {
  await terminalTab(name).click({ button: "right" })
  const menu = page.getByRole("menu", { name: labelled("", name, " actions") })
  await expect.element(menu).toBeVisible()
  return menu
}
