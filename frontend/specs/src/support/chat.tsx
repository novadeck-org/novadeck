import { expect } from "vitest"
import type { Locator } from "vitest/browser"

import { openWorkspace, terminal, terminalTab } from "./workspace"

// Vocabulary for a terminal's chat view: the conversation, the composer and the cards for
// what waits on the person.

/**
 * Opens the agents demo, whose agents have conversations, in an
 * app that follows experimental builds, so the experimental chat view is there; with it on, as
 * Preferences → Experimental turns it on, unless `chatView` is false. With `experimental`
 * false, the app has no update channel, as the browser's, so the flag stays off.
 */
export const openChatDemo = async (
  route = "/",
  { chatView = true, experimental = true, gap = false } = {},
): Promise<void> => {
  localStorage.setItem("novadeck.preferences", JSON.stringify({ chatView }))
  await openWorkspace(
    `${route}?demo=agents${experimental ? "&channel=experimental" : ""}${gap ? "&gap=on" : ""}`,
  )
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

/** A small PNG made on the spot, named `name`, `size` of a side. */
export const imageFile = async (name: string, size = 48): Promise<File> => {
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext("2d")!
  const gradient = context.createLinearGradient(0, 0, size, size)
  gradient.addColorStop(0, "#e5484d")
  gradient.addColorStop(1, "#3e63dd")
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((made) => resolve(made!)))
  return new File([blob], name, { type: "image/png" })
}

/**
 * Pastes `files` into the box as the browser does on Ctrl+V, Ctrl+Shift+V or ⌘V with them on the
 * clipboard, and answers whether the paste was left to the box (not taken by the chat).
 */
export const pasteInto = async (box: Locator, files: readonly File[]): Promise<boolean> => {
  const data = new DataTransfer()
  for (const file of files) data.items.add(file)
  const event = new ClipboardEvent("paste", {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  })
  box.element().dispatchEvent(event)
  return !event.defaultPrevented
}

/** The chips of the images waiting for the next message. */
export const attachments = (chat: Locator): Locator =>
  chat.getByRole("list", { name: "Images for the next message" })
