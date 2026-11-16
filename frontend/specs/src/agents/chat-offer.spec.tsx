import { userEvent } from "vitest/browser"
import { page, type Locator } from "vitest/browser"

import { chatOf, openChatDemo } from "../support/chat"
import { closePreferences, openPreferencesOn, preferencesDialog } from "../support/keyboard"
import {
  chooseView,
  commandInput,
  expectStaysAbsent,
  openWorkspace,
  reloadWorkspace,
  terminalTab,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// Agent Chat's one-time offer: the footer's card for people whose saved settings have the chat
// view off and no note that it was offered. The agents demo's terminals "Build" and
// "Checkout implementation" run agents; "Dev server" is a shell.
const card = (): Locator => page.getByRole("region", { name: "Agent Chat", exact: true })
const turnOn = (): Locator => card().getByRole("button", { name: "Turn on" })
const noThanks = (): Locator => card().getByRole("button", { name: "No thanks" })
const announcer = (): Locator => page.getByRole("status").filter({ hasText: /^Agent Chat: / })
const answeredKey = "novadeck.agent-chat-offer-answered"

// Opens the agents demo as an existing user's: the chat view off, nothing said about the offer.
const openAsExistingUser = (route = "/"): Promise<void> => openChatDemo(route, { chatView: false })

describe("Agent Chat's offer", () => {
  context("for someone whose chat view is off and who was never offered it", () => {
    it("rises over the footer on an agent's terminal, saying what it does and where to change it", async () => {
      await openAsExistingUser()
      await terminalTab("Build").click()
      await expect.element(card()).toBeVisible()
      await expect
        .element(card().getByText("Read and reply to agents in a chat instead of their terminal."))
        .toBeVisible()
      await expect
        .element(
          card().getByText("You can change this any time in Preferences → General → Agents."),
        )
        .toBeVisible()
      await expect.element(turnOn()).toBeVisible()
      await expect.element(noThanks()).toBeVisible()
    })

    it("announces itself once, politely, and takes no focus", async () => {
      await openAsExistingUser()
      await terminalTab("Build").click()
      await expect.element(card()).toBeVisible()
      await expect.element(announcer()).toBeInTheDocument()
      expect(announcer().element().getAttribute("aria-live")).toBe("polite")
      expect(card().element().contains(document.activeElement)).toBe(false)
    })

    it("comes up only while an agent's terminal is selected", async () => {
      await openAsExistingUser()
      await terminalTab("Dev server").click()
      await expect.element(commandInput("Dev server")).toBeVisible()
      await expectStaysAbsent(card())
      await terminalTab("Build").click()
      await expect.element(card()).toBeVisible()
      await terminalTab("Dev server").click()
      await expect.element(card()).not.toBeInTheDocument()
    })

    it("comes up the same in Grid and in Canvas", async () => {
      await openAsExistingUser()
      await terminalTab("Build").click()
      for (const name of ["Grid", "Canvas"] as const) {
        // eslint-disable-next-line no-await-in-loop -- Each view is looked at on its own.
        await chooseView(name)
        // eslint-disable-next-line no-await-in-loop -- Each view is looked at on its own.
        await expect.element(card()).toBeVisible()
      }
    })
  })

  context("with Turn on", () => {
    it("shows the selected agent as a chat, and never offers again", async () => {
      await openAsExistingUser()
      await terminalTab("Build").click()
      await turnOn().click()
      await expect.element(card()).not.toBeInTheDocument()
      await expect.element(chatOf("Build")).toBeVisible()
      // It is the chat view's own setting from now on: a person who turns it off is not asked.
      await openPreferencesOn("General")
      const chatView = preferencesDialog().getByRole("switch", { name: "Agent Chat" })
      await expect.element(chatView).toHaveAttribute("aria-checked", "true")
      await chatView.click()
      await closePreferences()
      await reloadWorkspace()
      await terminalTab("Build").click()
      await expectStaysAbsent(card())
    })
  })

  context("with No thanks", () => {
    it("leaves the terminal as it is, and never offers again", async () => {
      await openAsExistingUser()
      await terminalTab("Build").click()
      await noThanks().click()
      await expect.element(card()).not.toBeInTheDocument()
      await expect.element(commandInput("Build")).toBeVisible()
      await expect.element(chatOf("Build")).not.toBeInTheDocument()
      expect(localStorage.getItem(answeredKey)).toBe("true")
      // Another launch: the note is in storage, the saved settings say off.
      await reloadWorkspace()
      await terminalTab("Build").click()
      await expect.element(commandInput("Build")).toBeVisible()
      await expectStaysAbsent(card())
    })

    it("counts the × as No thanks", async () => {
      await openAsExistingUser()
      await terminalTab("Build").click()
      await card().getByRole("button", { name: "Dismiss" }).click()
      await expect.element(card()).not.toBeInTheDocument()
      expect(localStorage.getItem(answeredKey)).toBe("true")
    })

    it("counts Escape from inside the card as No thanks, and puts typing back in the terminal", async () => {
      await openAsExistingUser()
      await terminalTab("Build").click()
      await expect.element(commandInput("Build")).toHaveFocus()
      noThanks().element().focus()
      await expect.element(noThanks()).toHaveFocus()
      await userEvent.keyboard("{Escape}")
      await expect.element(card()).not.toBeInTheDocument()
      await expect.element(commandInput("Build")).toHaveFocus()
      expect(localStorage.getItem(answeredKey)).toBe("true")
    })

    it("leaves typing in a terminal alone while it is up, and is reached by the keyboard", async () => {
      await openAsExistingUser()
      await terminalTab("Build").click()
      await expect.element(card()).toBeVisible()
      await expect.element(commandInput("Build")).toHaveFocus()
      await userEvent.keyboard("echo hi")
      await expect.element(card()).toBeVisible()
      turnOn().element().focus()
      await expect.element(turnOn()).toHaveFocus()
    })
  })

  context("when the person settles the chat view some other way", () => {
    it("is answered by the Preferences switch, so turning it off again is not followed by an offer", async () => {
      await openAsExistingUser()
      await terminalTab("Build").click()
      await expect.element(card()).toBeVisible()
      await openPreferencesOn("General")
      // A dialog holds the corner.
      await expect.element(card()).not.toBeInTheDocument()
      const chatView = preferencesDialog().getByRole("switch", { name: "Agent Chat" })
      await chatView.click()
      await chatView.click()
      await expect.element(chatView).toHaveAttribute("aria-checked", "false")
      await closePreferences()
      await expectStaysAbsent(card())
    })

    it("is answered by finishing the welcome dialog, either way", async () => {
      await openWorkspace("/?demo=welcome")
      const welcome = page.getByRole("dialog", { name: "Welcome to Novadeck" })
      await welcome.getByRole("checkbox", { name: "Agent Chat" }).click()
      await welcome.getByRole("button", { name: "Skip for now" }).click()
      await expect.element(welcome).not.toBeInTheDocument()
      expect(localStorage.getItem(answeredKey)).toBe("true")
      await terminalTab("Build").click()
      await expect.element(commandInput("Build")).toBeVisible()
      await expectStaysAbsent(card())
    })
  })

  context("where the backend reads no conversations", () => {
    it("is not offered", async () => {
      await openWorkspace("/")
      await terminalTab("Checkout review").click()
      await expect.element(commandInput("Checkout review")).toBeVisible()
      await expectStaysAbsent(card())
    })
  })
})
