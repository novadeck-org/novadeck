import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { AgentChatOffer, chatOfferText, type AgentChatOfferProps } from "./AgentChatOffer"

const mounted: Rendered[] = []
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  document.body.replaceChildren()
})

const offer = (over: Partial<AgentChatOfferProps> = {}): AgentChatOfferProps => ({
  blocked: false,
  onTurnOn: () => {},
  onDecline: () => {},
  returnFocus: () => true,
  ...over,
})
const show = (card: AgentChatOfferProps | undefined, hidden = false) => {
  const page = render(createElement(AgentChatOffer, { offer: card, hidden }))
  mounted.push(page)
  return page
}
const card = (page: Rendered) => page.container.querySelector<HTMLElement>(".chat-offer")
const named = (page: Rendered, name: string) =>
  [...page.container.querySelectorAll("button")].find(
    (button) => button.textContent === name || button.ariaLabel === name,
  )!
const press = (page: Rendered, name: string) => act(() => named(page, name).click())
const announcer = (page: Rendered) => page.container.querySelector("[role=status]")!

describe("Agent Chat's offer card", () => {
  context("when it is due", () => {
    it("says what the chat does, where to change it, and offers Turn on and No thanks", () => {
      const page = show(offer())
      const text = card(page)!.textContent
      expect(text).toContain("Agent Chat")
      expect(text).toContain("Read and reply to agents in a chat instead of their terminal.")
      expect(text).toContain("You can change this any time in Preferences → Appearance → Layout.")
      expect(
        [...card(page)!.querySelectorAll("button")].map(
          (b) => b.getAttribute("aria-label") ?? b.textContent,
        ),
      ).toEqual(["Dismiss", "No thanks", "Turn on"])
    })

    it("is a region named for the feature, and never takes focus by itself", () => {
      const page = show(offer())
      const region = card(page)!
      expect(document.getElementById(region.getAttribute("aria-labelledby")!)?.textContent).toBe(
        chatOfferText.title,
      )
      expect(region.contains(document.activeElement)).toBe(false)
    })

    it("says itself once, politely, in a live region that was there before it", () => {
      const page = show(undefined)
      expect(announcer(page).getAttribute("aria-live")).toBe("polite")
      expect(announcer(page).textContent).toBe("")
      page.rerender(createElement(AgentChatOffer, { offer: offer(), hidden: false }))
      expect(announcer(page).textContent).toContain("Agent Chat: Read and reply")
    })
  })

  context("when it is answered", () => {
    it("turns on with Turn on, which is the only press that does", () => {
      const onTurnOn = vi.fn<() => void>()
      const onDecline = vi.fn<() => void>()
      const page = show(offer({ onTurnOn, onDecline }))
      press(page, "Turn on")
      expect(onTurnOn).toHaveBeenCalledOnce()
      expect(onDecline).not.toHaveBeenCalled()
    })

    it("declines with No thanks, the × and Escape from inside the card", () => {
      const onTurnOn = vi.fn<() => void>()
      const onDecline = vi.fn<() => void>()
      const page = show(offer({ onTurnOn, onDecline }))
      page.container.querySelector<HTMLButtonElement>(".update-card-close")!.click()
      expect(onDecline).toHaveBeenCalledTimes(1)
      press(page, "No thanks")
      expect(onDecline).toHaveBeenCalledTimes(2)
      act(() =>
        card(page)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      )
      expect(onDecline).toHaveBeenCalledTimes(3)
      expect(onTurnOn).not.toHaveBeenCalled()
    })

    it("gives typing focus back to the terminal when the button pressed had it", () => {
      const returnFocus = vi.fn<() => boolean>(() => true)
      const page = show(offer({ returnFocus }))
      const button = named(page, "Turn on")
      button.focus()
      act(() => button.click())
      expect(returnFocus).toHaveBeenCalledOnce()
    })

    it("leaves focus alone when a press came from elsewhere", () => {
      const returnFocus = vi.fn<() => boolean>(() => true)
      const page = show(offer({ returnFocus }))
      act(() => named(page, "Turn on").click())
      expect(returnFocus).not.toHaveBeenCalled()
    })
  })

  context("while something else holds the corner", () => {
    it("waits while blocked or hidden, and is there once they end", () => {
      const page = show(offer({ blocked: true }))
      expect(card(page)).toBeNull()
      page.rerender(createElement(AgentChatOffer, { offer: offer(), hidden: true }))
      expect(card(page)).toBeNull()
      page.rerender(createElement(AgentChatOffer, { offer: offer(), hidden: false }))
      expect(card(page)).not.toBeNull()
    })

    it("says itself once, not again when it is not due for a while and comes back", () => {
      const page = show(offer())
      expect(announcer(page).textContent).not.toBe("")
      // A shell selected between two agents: nothing to offer, then the offer again.
      page.rerender(createElement(AgentChatOffer, { offer: undefined, hidden: false }))
      expect(announcer(page).textContent).toBe("")
      page.rerender(createElement(AgentChatOffer, { offer: offer(), hidden: false }))
      expect(card(page)).not.toBeNull()
      expect(announcer(page).textContent).toBe("")
    })

    it("leaves nothing to browse while it waits, and does not say itself again on its return", () => {
      const page = show(offer())
      expect(announcer(page).textContent).not.toBe("")
      page.rerender(
        createElement(AgentChatOffer, { offer: offer({ blocked: true }), hidden: false }),
      )
      expect(announcer(page).textContent).toBe("")
      page.rerender(createElement(AgentChatOffer, { offer: offer(), hidden: false }))
      expect(announcer(page).textContent).toBe("")
      expect(card(page)).not.toBeNull()
    })
  })

  context("when it is not due", () => {
    it("shows nothing", () => {
      const page = show(undefined)
      expect(card(page)).toBeNull()
      expect(page.container.querySelector("button")).toBeNull()
    })
  })
})
