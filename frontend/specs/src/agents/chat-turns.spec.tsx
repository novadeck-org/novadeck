import { afterEach } from "vitest"

import { chatOf, openChat, openChatDemo } from "../support/chat"
import { chooseView, terminal } from "../support/workspace"
import { describe, expect, it } from "../test"

// The debug panel's hold (demo-debug's pane-turns.ts), which holds chats' turns as it holds
// companion panes': a chat coming into sight keeps its stand-in until the turns are let go.
const held = "data-pane-turns-held"
const hold = (): void => document.documentElement.setAttribute(held, "")
const letGo = (): void => document.documentElement.removeAttribute(held)

const standIn = (name: string) =>
  terminal(name).getByRole("progressbar", { name: `Opening the chat of ${name}` })

describe("A chat coming into sight", () => {
  afterEach(letGo)

  it("stands in as its terminal's name in Grid until its turn, then shows", async () => {
    await openChatDemo()
    await openChat("Checkout implementation")
    hold()
    await chooseView("Grid")
    await expect.element(standIn("Checkout implementation")).toBeVisible()
    await expect.element(chatOf("Checkout implementation")).not.toBeInTheDocument()

    letGo()
    await expect.element(standIn("Checkout implementation")).not.toBeInTheDocument()
    await expect.element(chatOf("Checkout implementation")).toBeVisible()
  })
})
