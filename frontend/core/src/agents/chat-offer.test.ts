import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { readChatOfferAnswered, writeChatOfferAnswered } from "./chat-offer"

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("the note that Agent Chat was offered", () => {
  it("is absent for someone whose storage has none, as every user from before the offer", () => {
    expect(readChatOfferAnswered()).toBe(false)
  })

  it("is read back as written, and can be written away", () => {
    writeChatOfferAnswered(true)
    expect(readChatOfferAnswered()).toBe(true)
    writeChatOfferAnswered(false)
    expect(readChatOfferAnswered()).toBe(false)
  })

  it("reads as not answered, and writes quietly, where local storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readChatOfferAnswered()).toBe(false)
    expect(() => writeChatOfferAnswered(true)).not.toThrow()
  })
})
