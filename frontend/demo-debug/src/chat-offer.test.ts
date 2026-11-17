import { readChatOfferAnswered, writeChatOfferAnswered } from "@novadeck/core/agents/chat-offer"
import { afterEach, vi } from "vitest"

import type { BootRehearsal } from "./boot-rehearsal"
import { chatOfferGroups } from "./chat-offer"
import type { DemoLaunch } from "./debug-demo"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const rehearse = vi.fn<(rehearsal: BootRehearsal) => void>()
const launch = { rehearsals: { rehearse } } as unknown as DemoLaunch

afterEach(() => {
  localStorage.clear()
  rehearse.mockClear()
})

describe("the debug panel's Agent Chat offer group", () => {
  it("is absent where the backend reads no conversations", () => {
    expect(chatOfferGroups(launch, false)).toEqual([])
  })

  it("sits in the App section with one action, hinted with what appears", () => {
    const [group] = chatOfferGroups(launch, true)
    expect(group?.section).toBe("App")
    expect(group?.actions.map((action) => action.label)).toEqual(["Offer Agent Chat"])
    expect(group?.actions[0]?.hint).toMatch(/Turn on and No thanks/)
  })

  it("turns the saved chat view off, forgets the answer, keeps other preferences, and boots again", () => {
    localStorage.setItem("novadeck.preferences", JSON.stringify({ chatView: true, fontSize: 15 }))
    writeChatOfferAnswered(true)
    const [group] = chatOfferGroups(launch, true)
    const action = group!.actions[0]!
    expect(action.reboots).toBe(true)
    void action.run({} as DemoActionContext)
    expect(JSON.parse(localStorage.getItem("novadeck.preferences")!)).toEqual({
      chatView: false,
      fontSize: 15,
    })
    expect(readChatOfferAnswered()).toBe(false)
    expect(rehearse).toHaveBeenCalledWith({ reboot: true })
  })

  it("works from storage that holds no preferences yet", () => {
    const [group] = chatOfferGroups(launch, true)
    void group!.actions[0]!.run({} as DemoActionContext)
    expect(JSON.parse(localStorage.getItem("novadeck.preferences")!)).toEqual({ chatView: false })
  })
})
