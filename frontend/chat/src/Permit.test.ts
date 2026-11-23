import type { ChatPermit } from "@novadeck/core/conversation"
import { refusing } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement, StrictMode } from "react"
import { afterEach, vi } from "vitest"

import { Requests } from "./Requests"
import { describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const permit = (change: Partial<ChatPermit> = {}): ChatPermit => ({
  id: "p1",
  title: "Merge PR #1190 into main",
  quote: "merge it",
  givenAt: Date.now(),
  until: Date.now() + 60 * 60_000,
  usedAt: null,
  ...change,
})

const show = (permits: readonly ChatPermit[], onTakeBack?: (permit: string) => Promise<void>) => {
  // As the app draws it in development, where its effects run, stop and run again.
  const { container, unmount } = render(
    createElement(
      StrictMode,
      null,
      createElement(Requests, {
        requests: [],
        permits,
        onTakeBack,
        slice: null,
        agent: "Claude",
        onAnswer: async () => {},
        onAnswerInTerminal: () => {},
        onSettled: () => {},
        replying: null,
        replySending: false,
        onReply: () => {},
        onSubmitted: () => {},
        refused: refusing("x", "x"),
      }),
    ),
  )
  unmounts.push(unmount)
  return container
}

const take = (container: HTMLElement): HTMLButtonElement =>
  [...container.querySelectorAll("button")].find((each) => each.textContent?.includes("Take back"))!

describe("A standing permit in the chat", () => {
  it("shows as the gate card's settled state: Allowed, what it covers, whose words, until when", () => {
    const container = show([permit()], async () => {})

    const card = container.querySelector(".request-card")!
    expect(card.querySelector("h3")?.textContent).toBe("Allowed")
    expect(card.textContent).toContain("Merge PR #1190 into main")
    expect(card.textContent).toContain('On your words: "merge it"')
    expect(card.textContent).toMatch(/Stands until \d\d:\d\d, or its first use/)
  })

  it("says it was allowed on the card where no words were typed, and when it was used", () => {
    const container = show([permit({ quote: null, usedAt: Date.now() })], async () => {})

    expect(container.textContent).toContain("You allowed it on its card")
    expect(container.textContent).toMatch(/Used at \d\d:\d\d · ends/)
  })

  it("offers no Take back where the backend can't", () => {
    expect(take(show([permit()]))).toBeUndefined()
  })

  it("takes the permit back by its id", async () => {
    const onTakeBack = vi.fn<(permit: string) => Promise<void>>(async () => {})
    const container = show([permit()], onTakeBack)

    await act(async () => take(container).click())

    expect(onTakeBack).toHaveBeenCalledWith("p1")
  })

  it("says on the card why a Take back failed, never as if it had taken", async () => {
    const container = show([permit()], async () => {
      throw new Error("The runner is offline.")
    })

    await act(async () => take(container).click())

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The runner is offline.")
    expect(container.textContent).toContain("Merge PR #1190 into main")
  })
})
