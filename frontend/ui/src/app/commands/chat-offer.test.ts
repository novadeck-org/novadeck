import { readChatOfferAnswered } from "@novadeck/core/agents/chat-offer"
import { afterEach } from "vitest"

import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import { persistUi } from "../ui-store"

afterEach(() => localStorage.clear())

const open = () => {
  const app = openCommands()
  persistUi(app.ui, app.workspace)
  return {
    ...app,
    answered: () => app.ui.getSnapshot().chatOfferAnswered,
    chatView: () => app.ui.getSnapshot().preferences.chatView,
  }
}

describe("answering Agent Chat's offer", () => {
  it("starts unanswered", () => {
    const app = open()
    expect(app.answered()).toBe(false)
    expect(app.chatView()).toBe(false)
  })

  context("with Try Agent Chat", () => {
    it("turns the chat view on, through the preferences, and is answered for good", () => {
      const app = open()
      app.commands.acceptChatOffer()
      expect(app.chatView()).toBe(true)
      expect(app.answered()).toBe(true)
      expect(readChatOfferAnswered()).toBe(true)
      expect(JSON.parse(localStorage.getItem("novadeck.preferences")!)).toMatchObject({
        chatView: true,
      })
    })
  })

  context("with No thanks", () => {
    it("is answered for good and leaves the chat view off", () => {
      const app = open()
      app.commands.declineChatOffer()
      expect(app.chatView()).toBe(false)
      expect(app.answered()).toBe(true)
      expect(readChatOfferAnswered()).toBe(true)
    })
  })

  context("when the welcome dialog is finished with Agent Chat unticked", () => {
    it("holds the offer for this run, answering nothing, so a reload offers it again", () => {
      const app = open()
      app.commands.holdChatOffer()
      expect(app.ui.getSnapshot().chatOfferHeld).toBe(true)
      expect(app.answered()).toBe(false)
      expect(readChatOfferAnswered()).toBe(false)
    })
  })

  context("when the welcome dialog changes the chat view", () => {
    it("is no answer by itself, so the dialog's finish decides: held after unticking an on setting", () => {
      const fresh = open()
      fresh.commands.updatePreferences(
        { ...fresh.ui.getSnapshot().preferences, chatView: true },
        { answersOffer: false },
      )
      expect(fresh.answered()).toBe(false)
      fresh.commands.updatePreferences(
        { ...fresh.ui.getSnapshot().preferences, chatView: false },
        { answersOffer: false },
      )
      expect(fresh.answered()).toBe(false)
      fresh.commands.holdChatOffer()
      expect(fresh.ui.getSnapshot().chatOfferHeld).toBe(true)
      expect(fresh.answered()).toBe(false)
    })
  })

  context("when the person chooses the chat view themselves", () => {
    it("is answered by the choice in Preferences, either way", () => {
      const app = open()
      app.commands.updatePreferences({ ...app.ui.getSnapshot().preferences, chatView: true })
      expect(app.answered()).toBe(true)
      expect(readChatOfferAnswered()).toBe(true)
    })

    it("is not answered by another preference changing", () => {
      const app = open()
      app.commands.updatePreferences({ ...app.ui.getSnapshot().preferences, fontSize: 15 })
      expect(app.answered()).toBe(false)
      expect(readChatOfferAnswered()).toBe(false)
    })
  })
})
