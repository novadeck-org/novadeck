import type { ChatItem, ChatSlice } from "@novadeck/core/conversation"
import { renderHook } from "@novadeck/test-kit/render"
import { act } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { useEchoes, viewMs } from "./echoes"
import { describe, expect, it } from "./test"

const view = (secret = false): ChatSlice => ({
  reason: "view",
  columns: 80,
  rows: [],
  cursor: null,
  secret,
})

type Props = { readonly slice: ChatSlice | null; readonly items: readonly ChatItem[] }

const setup = () =>
  renderHook(({ slice, items }: Props) => useEchoes(slice, items), {
    slice: null,
    items: [],
  } as Props)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe("useEchoes", () => {
  it("echoes a command as the person's words", () => {
    const { result } = setup()
    act(() => result.current.echo("/status"))
    expect(result.current.shown.map(({ text }) => text)).toEqual(["/status"])
  })

  it("keeps the last of the view it opened, once it goes", () => {
    const { result, rerender } = setup()
    act(() => result.current.echo("/model"))
    const first = view()
    const last = { ...view(), columns: 90 }
    rerender({ slice: first, items: [] })
    rerender({ slice: last, items: [] })
    expect(result.current.shown[0]?.slice).toBeNull()
    rerender({ slice: null, items: [] })
    expect(result.current.shown[0]?.slice).toBe(last)
  })

  it("keeps no copy of a secret prompt, nor of the view before it", () => {
    const { result, rerender } = setup()
    act(() => result.current.echo("/login"))
    rerender({ slice: view(), items: [] })
    rerender({ slice: view(true), items: [] })
    rerender({ slice: view(), items: [] })
    rerender({ slice: null, items: [] })
    expect(result.current.shown[0]?.slice).toBeNull()
  })

  it("takes no view that comes long after it for its own", () => {
    const { result, rerender } = setup()
    act(() => result.current.echo("/compact"))
    vi.setSystemTime(1000 + viewMs + 1)
    rerender({ slice: view(), items: [] })
    expect(result.current.shown[0]?.slice).toBeNull()
  })

  it("keeps a menu's rows out of it", () => {
    const { result, rerender } = setup()
    act(() => result.current.echo("/mo"))
    rerender({ slice: { ...view(), reason: "menu" }, items: [] })
    expect(result.current.shown[0]?.slice).toBeNull()
  })

  it("takes back one that ran nothing", () => {
    const { result } = setup()
    act(() => result.current.echo("/nothing"))
    act(() => result.current.drop())
    expect(result.current.shown).toEqual([])
  })

  it("gives way to a transcript that records the command", () => {
    const { result, rerender } = setup()
    act(() => result.current.echo("/compact"))
    const item = { role: "user", text: "/compact", at: 1500 } as ChatItem
    rerender({ slice: null, items: [item] })
    expect(result.current.shown).toEqual([])
  })

  it("keeps an earlier run's words of the same command apart", () => {
    const { result, rerender } = setup()
    act(() => result.current.echo("/compact"))
    const item = { role: "user", text: "/compact", at: 0 - 5000 } as ChatItem
    rerender({ slice: null, items: [item] })
    expect(result.current.shown).toHaveLength(1)
  })
})
