import type { ChatBox, ChatSlice } from "@novadeck/core/conversation"
import { act } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { renderHook } from "./hook.test-support"
import { boxLagMs, editKeys, terminalKey, usePassing, type Passing } from "./passing"
import { describe, expect, it } from "./test"

const box = (text: string): ChatBox => ({ text, mode: "prompt", tail: false, known: false })

const slice = (reason: ChatSlice["reason"]): ChatSlice => ({
  reason,
  columns: 80,
  rows: [],
  cursor: null,
  secret: false,
})

type Props = {
  readonly agent: string | null
  readonly open: boolean
  readonly draft: string
  readonly box: ChatBox | null
  readonly slice: ChatSlice | null
}

const given: Props = { agent: "claude", open: true, draft: "", box: null, slice: null }

const setup = (
  props: Partial<Props> = {},
  write = vi.fn<(keys: string) => Promise<void>>(async () => {}),
) => {
  const onDraft = vi.fn<(draft: string) => void>()
  const view = renderHook((current: Props) => usePassing({ ...current, onDraft, write }), {
    ...given,
    ...props,
  })
  const passing = (): Passing => view.result.current
  return { ...view, passing, onDraft, write }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("editKeys", () => {
  it("adds what was added, takes what went, writes an edit in between again", () => {
    expect(editKeys("/m", "/mo")).toBe("o")
    expect(editKeys("/mo", "/")).toBe("\x7f\x7f")
    expect(editKeys("/mo", "/ma")).toBe("\x15/ma")
    expect(editKeys("/m", "/m")).toBe("")
  })
})

describe("terminalKey", () => {
  const press = (key: string, fields = {}) =>
    terminalKey({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...fields })

  it("writes a named key, a character, and a control key", () => {
    expect(press("Enter")).toBe("\r")
    expect(press("Escape")).toBe("\x1b")
    expect(press("ArrowDown")).toBe("\x1b[B")
    expect(press("a")).toBe("a")
    expect(press("界")).toBe("界")
    expect(press("c", { ctrlKey: true })).toBe("\x03")
    expect(press("Tab", { shiftKey: true })).toBe("\x1b[Z")
  })

  it("leaves the app its own", () => {
    expect(press("F5")).toBeUndefined()
    expect(press("Shift")).toBeUndefined()
    expect(press("k", { metaKey: true })).toBeUndefined()
    expect(press("k", { altKey: true })).toBeUndefined()
  })
})

describe("usePassing", () => {
  it("passes a draft that calls up a menu, whole, and what is typed after it", () => {
    const { passing, rerender, write, onDraft } = setup()
    act(() => passing().edit("/"))
    expect(write).toHaveBeenCalledWith("/")
    expect(passing().on).toBe(true)
    expect(onDraft).toHaveBeenLastCalledWith("/")
    rerender({ ...given, draft: "/" })
    act(() => passing().edit("/m"))
    expect(write).toHaveBeenLastCalledWith("m")
  })

  it("passes a mention at the end of words", () => {
    const { passing, write } = setup()
    act(() => passing().edit("hello @"))
    expect(write).toHaveBeenCalledWith("hello @")
  })

  it("passes only the keys its harness has", () => {
    const claude = setup()
    expect(claude.passing().opens("cost in $")).toBe(false)
    const codex = setup({ agent: "codex" })
    expect(codex.passing().opens("use $sk")).toBe(true)
  })

  it("keeps a box that holds text out of it, and words with line breaks", () => {
    const { passing, write } = setup({ box: box("draft") })
    act(() => passing().edit("/"))
    expect(write).not.toHaveBeenCalled()
    expect(passing().on).toBe(false)
    expect(passing().opens("one\n/two")).toBe(false)
  })

  it("passes nothing where the backend takes no keys, or the box answers a question", () => {
    const onDraft = vi.fn<(draft: string) => void>()
    const none = renderHook(() => usePassing({ ...given, onDraft, write: undefined }), null)
    expect(none.result.current.opens("/")).toBe(false)
    expect(setup({ open: false }).passing().opens("/")).toBe(false)
    expect(setup({ agent: "bash" }).passing().opens("/")).toBe(false)
  })

  it("ends with the draft", () => {
    const { passing, rerender, write } = setup()
    act(() => passing().edit("/"))
    rerender({ ...given, draft: "/" })
    act(() => passing().edit(""))
    expect(write).toHaveBeenLastCalledWith("\x7f")
    expect(passing().on).toBe(false)
  })

  it("passes Esc only while something it closes shows, and no more than pressed", () => {
    const { passing, rerender, write } = setup()
    act(() => passing().edit("/"))
    rerender({ ...given, draft: "/", slice: slice("menu") })
    expect(passing().press("\x1b")).toBe(true)
    expect(write).toHaveBeenLastCalledWith("\x1b")
    write.mockClear()
    rerender({ ...given, draft: "/", slice: null })
    expect(passing().press("\x1b")).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it("takes no key while it isn't passing", () => {
    const { passing, write } = setup()
    expect(passing().press("\r")).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it("mirrors what Tab made of the text", () => {
    const { passing, rerender, onDraft } = setup()
    act(() => passing().edit("/ma"))
    rerender({ ...given, draft: "/ma", box: box("/ma") })
    act(() => {
      passing().press("\t")
    })
    rerender({ ...given, draft: "/ma", box: box("/marketplace") })
    expect(onDraft).toHaveBeenLastCalledWith("/marketplace")
    expect(passing().on).toBe(true)
  })

  it("goes once Enter leaves the box empty, however late the box says so", () => {
    const { passing, rerender, onDraft } = setup()
    act(() => passing().edit("/model"))
    rerender({ ...given, draft: "/model", box: box("/model") })
    act(() => {
      passing().press("\r")
    })
    rerender({ ...given, draft: "/model", box: null, slice: slice("view") })
    act(() => {
      vi.advanceTimersByTime(boxLagMs)
    })
    expect(onDraft).toHaveBeenLastCalledWith("")
    expect(passing().on).toBe(false)
  })

  it("keeps what the box keeps after Enter", () => {
    const { passing, rerender, onDraft } = setup({ agent: "agy" })
    act(() => passing().edit("/re"))
    rerender({ ...given, agent: "agy", draft: "/re", box: box("/re") })
    act(() => {
      passing().press("\r")
    })
    rerender({ ...given, agent: "agy", draft: "/re", box: box("/remote-control") })
    expect(onDraft).toHaveBeenLastCalledWith("/remote-control")
    expect(passing().on).toBe(true)
  })

  it("goes on from the box as the chat comes back to a menu", () => {
    const { passing, onDraft } = setup({ box: box("/mo"), slice: slice("menu") })
    expect(passing().on).toBe(true)
    expect(onDraft).toHaveBeenCalledWith("/mo")
  })

  it("leaves a box that holds a command with no menu to the note", () => {
    const { passing } = setup({ box: box("/mo") })
    expect(passing().on).toBe(false)
  })

  it("lets the words go back to the chat's rule when the terminal took none", async () => {
    const { passing } = setup(
      {},
      vi.fn<(keys: string) => Promise<void>>(async () => Promise.reject(new Error("no agent"))),
    )
    await act(async () => {
      passing().edit("/")
      await Promise.resolve()
    })
    expect(passing().on).toBe(false)
  })

  it("lets the draft go as the person leaves with a menu up", () => {
    const { passing, unmount, onDraft } = setup()
    act(() => passing().edit("/mo"))
    onDraft.mockClear()
    unmount()
    expect(onDraft).toHaveBeenCalledWith("")
  })
})
