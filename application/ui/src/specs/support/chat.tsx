import { expect } from "vitest"
import { page, type Locator } from "vitest/browser"

import { openWorkspace, terminal, terminalTab } from "./workspace"

// Vocabulary for a terminal's chat view: the toggle in its header, the conversation, the
// composer and the cards for what waits on the person.

/** Opens the agents demo, whose agents have conversations, past the first-run welcome. */
export const openChatDemo = async (route = "/"): Promise<void> => {
  await openWorkspace(`${route}?demo=agents`)
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
}

/** The header's switch between a terminal and its chat. */
export const chatToggle = (name: string): Locator =>
  terminal(name).getByRole("button", { name: `Chat view: ${name}`, exact: true })

/** Selects a terminal and shows its chat. */
export const openChat = async (name: string): Promise<Locator> => {
  await terminalTab(name).click()
  await chatToggle(name).click()
  const chat = terminal(name).getByRole("region", { name: `${name} chat`, exact: true })
  await expect.element(chat).toBeVisible()
  return chat
}

/** The box that writes to the agent. */
export const composer = (chat: Locator): Locator => chat.getByRole("textbox", { name: /^Message / })

/** The conversation's log. */
export const conversation = (chat: Locator): Locator =>
  chat.getByRole("log", { name: /^Conversation with / })
