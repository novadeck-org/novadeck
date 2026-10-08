import { expect } from "vitest"
import { page, type Locator } from "vitest/browser"

import { openWorkspace, terminal, terminalTab } from "./workspace"

// Vocabulary for a terminal's chat view: the conversation, the composer and the cards for
// what waits on the person.

/**
 * Opens the agents demo, whose agents have conversations, past the first-run welcome; with
 * the chat view on, as Preferences → Addons turns it on, unless `chatView` is false.
 */
export const openChatDemo = async (route = "/", { chatView = true } = {}): Promise<void> => {
  localStorage.setItem("novadeck.preferences", JSON.stringify({ chatView }))
  await openWorkspace(`${route}?demo=agents`)
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
}

/** A terminal's chat, where it shows. */
export const chatOf = (name: string): Locator =>
  terminal(name).getByRole("region", { name: `${name} chat`, exact: true })

/** Selects a terminal, which shows its chat. */
export const openChat = async (name: string): Promise<Locator> => {
  await terminalTab(name).click()
  const chat = chatOf(name)
  await expect.element(chat).toBeVisible()
  return chat
}

/** The box that writes to the agent. */
export const composer = (chat: Locator): Locator => chat.getByRole("textbox", { name: /^Message / })

/** The conversation's log. */
export const conversation = (chat: Locator): Locator =>
  chat.getByRole("log", { name: /^Conversation with / })

/** The card of a request that waits on the person, by what it says it needs. */
export const requestCard = (chat: Locator, title: string | RegExp): Locator =>
  chat.getByRole("region", { name: "Waiting for you" }).getByRole("article", { name: title })
