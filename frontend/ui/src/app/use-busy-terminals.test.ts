import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement, useEffect } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { askAgainMs, useBusyTerminals, type BusyTerminals } from "./use-busy-terminals"

const mounted: Rendered[] = []
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  vi.useRealTimers()
})

type Told = { readonly busy: readonly string[]; readonly unknown: readonly string[] }
type Ask = () => Promise<Told | undefined>

// What the hook says, as a component that asks for it reads it.
const watch = (
  ask: Ask | undefined,
  active: boolean,
  shows: (id: string) => boolean = () => true,
) => {
  const latest: { current?: BusyTerminals } = {}
  const Probe = ({ to, on }: { to: Ask | undefined; on: boolean }) => {
    const value = useBusyTerminals(to, on, shows)
    useEffect(() => {
      latest.current = value
    })
    return null
  }
  const page = render(createElement(Probe, { to: ask, on: active }))
  mounted.push(page)
  return {
    now: () => latest.current!,
    set: (next: Ask | undefined, on: boolean) =>
      page.rerender(createElement(Probe, { to: next, on })),
  }
}

const deferred = () => {
  let resolve!: (told: Told | undefined) => void
  const promise = new Promise<Told | undefined>((done) => (resolve = done))
  return { promise, resolve }
}

describe("asking the runner about shells", () => {
  it("asks nothing while nobody looks, once when they do, and again after each answer", async () => {
    vi.useFakeTimers()
    const ask = vi.fn<Ask>(() => Promise.resolve({ busy: ["a"], unknown: [] }))
    const view = watch(ask, false)
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(ask).not.toHaveBeenCalled()
    view.set(ask, true)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(ask).toHaveBeenCalledOnce()
    expect(view.now().answer).toBe("known")
    expect(view.now().busy?.busy.has("a")).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(askAgainMs))
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it("says pending until the first answer, and unavailable for none", async () => {
    const first = deferred()
    const view = watch(() => first.promise, true)
    expect(view.now().answer).toBe("pending")
    await act(async () => first.resolve(undefined))
    expect(view.now().answer).toBe("unavailable")
  })

  it("lets go of an answer that comes after the card closed: it is not kept and nothing is asked again", async () => {
    vi.useFakeTimers()
    const late = deferred()
    const ask = vi.fn<Ask>(() => late.promise)
    const view = watch(ask, true)
    view.set(ask, false)
    await act(async () => late.resolve({ busy: ["a"], unknown: [] }))
    await act(() => vi.advanceTimersByTimeAsync(10 * askAgainMs))
    expect(ask).toHaveBeenCalledOnce()
    // Looking again starts from pending, not from the answer that came too late.
    const next = deferred()
    const again = vi.fn<Ask>(() => next.promise)
    view.set(again, true)
    expect(view.now().answer).toBe("pending")
    expect(view.now().busy).toBeUndefined()
  })

  it("starts from pending when the card opens again, not from the last answer", async () => {
    const view = watch(() => Promise.resolve({ busy: ["a"], unknown: [] }), true)
    await act(() => Promise.resolve())
    expect(view.now().answer).toBe("known")
    const slow = deferred()
    view.set(() => slow.promise, false)
    expect(view.now().answer).toBe("pending")
    view.set(() => slow.promise, true)
    expect(view.now().answer).toBe("pending")
    expect(view.now().busy).toBeUndefined()
  })

  it("asks for a fresh read as the restart is pressed, and holds back only for terminals the card shows", async () => {
    const ask = vi.fn<Ask>((options?: { fresh?: true }) =>
      Promise.resolve(
        options?.fresh ? { busy: ["elsewhere"], unknown: [] } : { busy: [], unknown: [] },
      ),
    )
    const view = watch(ask, true, (id) => id !== "elsewhere")
    await act(() => Promise.resolve())
    let go = false
    await act(async () => void (go = await view.now().recheck()))
    expect(ask).toHaveBeenLastCalledWith({ fresh: true })
    expect(go).toBe(true)
  })

  it("lets the restart go on unless a new answer names work the card did not show", async () => {
    const answers: Told[] = [
      { busy: ["a"], unknown: [] },
      { busy: ["a"], unknown: ["b"] },
    ]
    const ask = vi.fn<Ask>(() => Promise.resolve(answers.shift()))
    const view = watch(ask, true)
    await act(() => Promise.resolve())
    let go = true
    await act(async () => void (go = await view.now().recheck()))
    expect(go).toBe(false)
    expect(view.now().busy?.unknown.has("b")).toBe(true)
    // Nothing new, and an answer that fails, let it go on.
    ask.mockResolvedValueOnce({ busy: ["a"], unknown: ["b"] })
    await act(async () => void (go = await view.now().recheck()))
    expect(go).toBe(true)
    ask.mockRejectedValueOnce(new Error("gone"))
    await act(async () => void (go = await view.now().recheck()))
    expect(go).toBe(true)
  })
})
