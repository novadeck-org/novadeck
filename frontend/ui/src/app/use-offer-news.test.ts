import type { UpdateOffer, WhatsNew } from "@novadeck/core/desktop/update"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement, useEffect } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { newsWaitMs, useOfferNews } from "./use-offer-news"

type Ask = () => Promise<WhatsNew | undefined>

const offer = (version: string): UpdateOffer => ({ kind: "available", version })
const notes = (version: string): WhatsNew => ({
  version,
  highlights: [{ title: "A", line: "B" }],
})

// A page that shows what the hook says, and keeps `askAgain` for the test to press.
const pressed = { again: () => {} }
const again = (): void => pressed.again()
const Probe = ({ ask, offer: made }: { ask: Ask | undefined; offer: UpdateOffer | null }) => {
  const { news, settled, askAgain } = useOfferNews(ask, made)
  useEffect(() => {
    pressed.again = askAgain
  })
  return createElement("p", null, `${news?.version ?? "none"} ${settled ? "settled" : "waiting"}`)
}
const page = (ask: Ask | undefined, made: UpdateOffer | null) =>
  createElement(Probe, { ask, offer: made })

// A desktop app's answer that the test settles when it likes.
const pending = () => {
  const asks: { resolve: (news: WhatsNew | undefined) => void; reject: () => void }[] = []
  const ask: Ask = () =>
    new Promise(
      (resolve, reject) => void asks.push({ resolve, reject: () => reject(new Error("x")) }),
    )
  return { ask: vi.fn<Ask>(ask), asks }
}

const mounted: Rendered[] = []
const show = (element: ReturnType<typeof page>) => {
  const rendered = render(element)
  mounted.push(rendered)
  return rendered
}
const said = (rendered: Rendered) => rendered.container.textContent
const flush = () => act(() => Promise.resolve())

afterEach(() => {
  mounted.splice(0).forEach((rendered) => rendered.unmount())
  vi.useRealTimers()
})

describe("the news of an offered release", () => {
  it("waits for the first answer, then holds what the desktop app said", async () => {
    const { ask, asks } = pending()
    const rendered = show(page(ask, offer("0.0.80")))
    expect(said(rendered)).toBe("none waiting")
    asks[0]!.resolve(notes("0.0.80"))
    await flush()
    expect(said(rendered)).toBe("0.0.80 settled")
    expect(ask).toHaveBeenCalledOnce()
  })

  it("has nothing to wait for without an offer or a desktop app that tells", () => {
    const { ask } = pending()
    expect(said(show(page(ask, null)))).toBe("none settled")
    expect(said(show(page(undefined, offer("0.0.80"))))).toBe("none settled")
    expect(ask).not.toHaveBeenCalled()
  })

  it("drops a late answer for an offer that is gone", async () => {
    const { ask, asks } = pending()
    const rendered = show(page(ask, offer("0.0.80")))
    rendered.rerender(page(ask, offer("0.0.81")))
    expect(ask).toHaveBeenCalledTimes(2)
    asks[0]!.resolve(notes("0.0.80"))
    await flush()
    expect(said(rendered)).toBe("none waiting")
    asks[1]!.resolve(notes("0.0.81"))
    await flush()
    expect(said(rendered)).toBe("0.0.81 settled")
  })

  it("settles on none when the desktop app fails, and tries again when asked", async () => {
    const { ask, asks } = pending()
    const rendered = show(page(ask, offer("0.0.80")))
    asks[0]!.reject()
    await flush()
    expect(said(rendered)).toBe("none settled")
    act(() => again())
    expect(ask).toHaveBeenCalledTimes(2)
    asks[1]!.resolve(notes("0.0.80"))
    await flush()
    expect(said(rendered)).toBe("0.0.80 settled")
  })

  it("asks again after an empty answer, but not while an ask is out or notes are held", async () => {
    const { ask, asks } = pending()
    const rendered = show(page(ask, offer("0.0.80")))
    act(() => again())
    act(() => again())
    expect(ask).toHaveBeenCalledOnce()
    asks[0]!.resolve(undefined)
    await flush()
    expect(said(rendered)).toBe("none settled")
    act(() => again())
    expect(ask).toHaveBeenCalledTimes(2)
    asks[1]!.resolve(notes("0.0.80"))
    await flush()
    act(() => again())
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it("drops notes of another version than the offer's", async () => {
    const { ask, asks } = pending()
    const rendered = show(page(ask, offer("0.0.80")))
    asks[0]!.resolve(notes("0.0.79"))
    await flush()
    expect(said(rendered)).toBe("none settled")
  })

  it("lets go of an ask whose page is gone", async () => {
    const { ask, asks } = pending()
    const rendered = show(page(ask, offer("0.0.80")))
    rendered.unmount()
    mounted.pop()
    await act(async () => asks[0]!.resolve(notes("0.0.80")))
    expect(ask).toHaveBeenCalledOnce()
  })

  it("stops waiting once the desktop app's own wait would have run out", () => {
    vi.useFakeTimers()
    const { ask } = pending()
    const rendered = show(page(ask, offer("0.0.80")))
    act(() => void vi.advanceTimersByTime(newsWaitMs - 1))
    expect(said(rendered)).toBe("none waiting")
    act(() => void vi.advanceTimersByTime(1))
    expect(said(rendered)).toBe("none settled")
  })
})
