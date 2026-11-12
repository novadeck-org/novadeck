import type { ChatBox, ChatSlice } from "@novadeck/core/conversation"
import { renderHook } from "@novadeck/test-kit/render"
import { act } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import {
  boxLagMs,
  editKeys,
  terminalKey,
  usePassing,
  type Passing,
  type PassingState,
} from "./passing"
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
  const onKept = vi.fn<() => void>()
  const view = renderHook((current: Props) => usePassing({ ...current, onDraft, write, onKept }), {
    ...given,
    ...props,
  })
  const passing = (): Passing => view.result.current
  return { ...view, passing, onDraft, write, onKept }
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
    act(() => claude.passing().edit("cost in $"))
    expect(claude.write).not.toHaveBeenCalled()
    const codex = setup({ agent: "codex" })
    act(() => codex.passing().edit("use $sk"))
    expect(codex.write).toHaveBeenCalledWith("use $sk")
  })

  it("keeps a box that holds text out of it, and words it can't take as keys", () => {
    const held = setup({ box: box("draft") })
    act(() => held.passing().edit("/"))
    expect(held.write).not.toHaveBeenCalled()
    const lines = setup()
    act(() => lines.passing().edit("one\n/two"))
    act(() => lines.passing().edit("/a\x03b"))
    act(() => lines.passing().edit(`/${"x".repeat(2000)}`))
    expect(lines.write).not.toHaveBeenCalled()
    expect(lines.passing().on).toBe(false)
  })

  it("keeps out of a view that shows", () => {
    const { passing, write } = setup({ slice: slice("view") })
    act(() => passing().edit("/"))
    expect(write).not.toHaveBeenCalled()
  })

  it("passes nothing where the backend takes no keys, or the box answers a question", () => {
    const onDraft = vi.fn<(draft: string) => void>()
    const none = renderHook(() => usePassing({ ...given, onDraft, write: undefined }), null)
    act(() => none.result.current.edit("/"))
    expect(none.result.current.on).toBe(false)
    for (const props of [{ open: false }, { agent: "bash" }]) {
      const { passing, write } = setup(props)
      act(() => passing().edit("/"))
      expect(write).not.toHaveBeenCalled()
    }
  })

  it("stops as the box comes to answer a question", () => {
    const { passing, rerender } = setup()
    act(() => passing().edit("/"))
    rerender({ ...given, draft: "/", open: false })
    expect(passing().on).toBe(false)
    expect(passing().press("\r")).toBe(false)
  })

  it("ends with the draft, the box cleared", () => {
    const { passing, rerender, write } = setup()
    act(() => passing().edit("/"))
    rerender({ ...given, draft: "/" })
    act(() => passing().edit(""))
    expect(write).toHaveBeenLastCalledWith("\x15")
    expect(passing().on).toBe(false)
  })

  it("doesn't come back on what still shows as the person clears the draft", () => {
    const { passing, rerender, write, onDraft } = setup()
    act(() => passing().edit("/"))
    rerender({ ...given, draft: "/", box: box("/"), slice: slice("menu") })
    act(() => passing().edit(""))
    rerender({ ...given, draft: "", box: box("/"), slice: slice("menu") })
    expect(passing().on).toBe(false)
    expect(onDraft).toHaveBeenLastCalledWith("")
    rerender({ ...given, draft: "" })
    act(() => passing().edit("m"))
    expect(write).toHaveBeenLastCalledWith("\x15")
  })

  it("gives the words back as a message goes on past a mention", () => {
    const { passing, rerender, write, onDraft } = setup()
    act(() => passing().edit("see @a"))
    rerender({ ...given, draft: "see @a" })
    act(() => passing().edit("see @a "))
    expect(write).toHaveBeenLastCalledWith("\x15")
    expect(passing().on).toBe(false)
    expect(onDraft).toHaveBeenLastCalledWith("see @a ")
  })

  it("goes on past a space in a command's arguments", () => {
    const { passing, rerender, write } = setup()
    act(() => passing().edit("/model"))
    rerender({ ...given, draft: "/model" })
    act(() => passing().edit("/model x"))
    expect(write).toHaveBeenLastCalledWith(" x")
    expect(passing().on).toBe(true)
  })

  it("gives the words back as text replaces the command", () => {
    const { passing, rerender, write } = setup()
    act(() => passing().edit("/mod"))
    rerender({ ...given, draft: "/mod" })
    act(() => passing().edit("hello"))
    expect(write).toHaveBeenLastCalledWith("\x15")
    expect(passing().on).toBe(false)
  })

  it("keeps a draft too long for one row out of it, as one clear takes one row", () => {
    const { passing, write } = setup()
    act(() => passing().edit(`${"word ".repeat(12)}@`))
    expect(write).not.toHaveBeenCalled()
    const wide = setup({ slice: slice("menu") })
    const long = `/${"x".repeat(70)}`
    act(() => wide.passing().edit(long))
    expect(wide.write).toHaveBeenCalledWith(long)
  })

  it("gives the words back as they stop fitting a row", () => {
    const { passing, rerender, write } = setup()
    const fits = `/${"x".repeat(51)}`
    act(() => passing().edit(fits))
    rerender({ ...given, draft: fits })
    act(() => passing().edit(`${fits}y`))
    expect(write).toHaveBeenLastCalledWith("\x15")
    expect(passing().on).toBe(false)
  })

  it("keeps a shell command out of it", () => {
    const { passing, write } = setup()
    act(() => passing().edit("!cat @f"))
    expect(write).not.toHaveBeenCalled()
  })

  it("lets the harness judge what is typed behind Tab, and takes the box's word", () => {
    const { passing, rerender, write, onDraft } = setup()
    act(() => passing().edit("see @fi"))
    rerender({ ...given, draft: "see @fi", box: box("see @fi"), slice: slice("menu") })
    act(() => void passing().press("\t"))
    act(() => passing().edit("see @fi "))
    expect(write).toHaveBeenLastCalledWith(" ")
    rerender({ ...given, draft: "see @fi ", box: box("see @src/file.ts ") })
    act(() => void vi.advanceTimersByTime(0))
    expect(onDraft).toHaveBeenLastCalledWith("see @src/file.ts ")
  })

  it("mirrors a box that wrapped as one line", () => {
    const { passing, rerender, onDraft } = setup()
    act(() => passing().edit("/ma"))
    rerender({ ...given, draft: "/ma", box: box("/ma"), slice: slice("menu") })
    act(() => void passing().press("\t"))
    rerender({ ...given, draft: "/ma", box: box("/one\ntwo"), slice: slice("menu") })
    act(() => void vi.advanceTimersByTime(0))
    expect(onDraft).toHaveBeenLastCalledWith("/one two")
  })

  it("says whether keys pass, and that they may still show in the box till it reads empty", () => {
    const onPassing = vi.fn<(state: PassingState) => void>()
    const write = vi.fn<(keys: string) => Promise<void>>(async () => {})
    const { result, rerender } = renderHook(
      (props: Props) => usePassing({ ...props, onDraft: () => {}, write, onPassing }),
      given,
    )
    expect(onPassing).toHaveBeenLastCalledWith("off")
    act(() => result.current.edit("look at @sr"))
    expect(onPassing).toHaveBeenLastCalledWith("on")
    rerender({ ...given, draft: "look at @sr", box: box("look at @sr"), slice: slice("menu") })
    act(() => result.current.edit("look at @src "))
    expect(write).toHaveBeenLastCalledWith("\x15")
    rerender({ ...given, draft: "look at @src ", box: box("look at @sr"), slice: null })
    expect(onPassing).toHaveBeenLastCalledWith("ending")
    rerender({ ...given, draft: "look at @src ", box: null, slice: null })
    expect(onPassing).toHaveBeenLastCalledWith("off")
  })

  it("says keys may still show in the box when the box goes on to answer otherwise", () => {
    const onPassing = vi.fn<(state: PassingState) => void>()
    const write = vi.fn<(keys: string) => Promise<void>>(async () => {})
    const { result, rerender } = renderHook(
      (props: Props) => usePassing({ ...props, onDraft: () => {}, write, onPassing }),
      given,
    )
    act(() => result.current.edit("/"))
    rerender({ ...given, open: false, draft: "/", box: box("/") })
    expect(onPassing).toHaveBeenLastCalledWith("ending")
  })

  it("takes a character's Backspace, not a UTF-16 unit's", () => {
    expect(editKeys("/a😀", "/a")).toBe("\x7f")
  })

  it("passes menu keys only while something shows, and no more than pressed", () => {
    const { passing, rerender, write } = setup()
    act(() => passing().edit("/"))
    rerender({ ...given, draft: "/", slice: slice("menu") })
    for (const keys of ["\x1b", "\x1b[A", "\t"]) act(() => void passing().press(keys))
    expect(write.mock.calls.map(([keys]) => keys)).toEqual(["/", "\x1b", "\x1b[A", "\t"])
    write.mockClear()
    rerender({ ...given, draft: "/", slice: null })
    for (const keys of ["\x1b", "\x1b[A", "\x1b[B", "\t"]) expect(passing().press(keys)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it("passes Enter with the menu closed, the text kept", () => {
    const { passing, rerender, write } = setup()
    act(() => passing().edit("/mo"))
    rerender({ ...given, draft: "/mo", slice: null })
    act(() => void passing().press("\r"))
    expect(write).toHaveBeenLastCalledWith("\r")
  })

  it("clears the box for a Stop, and stops passing", async () => {
    const { passing, write } = setup()
    act(() => passing().edit("/mo"))
    await act(() => passing().leave())
    expect(write).toHaveBeenLastCalledWith("\x15")
    expect(passing().on).toBe(false)
  })

  it("takes no key while it isn't passing", () => {
    const { passing, write } = setup()
    expect(passing().press("\r")).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it("mirrors what Tab made of the text, however late", () => {
    const { passing, rerender, onDraft } = setup()
    act(() => passing().edit("/ma"))
    rerender({ ...given, draft: "/ma", box: box("/ma"), slice: slice("menu") })
    act(() => void passing().press("\t"))
    act(() => void vi.advanceTimersByTime(boxLagMs * 3))
    rerender({ ...given, draft: "/ma", box: box("/marketplace"), slice: slice("menu") })
    act(() => void vi.advanceTimersByTime(0))
    expect(onDraft).toHaveBeenLastCalledWith("/marketplace")
    expect(passing().on).toBe(true)
  })

  it("goes once Enter leaves the box empty, however late the box says so", () => {
    const { passing, rerender, onDraft } = setup()
    act(() => passing().edit("/model"))
    rerender({ ...given, draft: "/model", box: box("/model") })
    act(() => void passing().press("\r"))
    act(() => void vi.advanceTimersByTime(boxLagMs * 3))
    expect(passing().on).toBe(true)
    rerender({ ...given, draft: "/model", box: null, slice: slice("view") })
    act(() => void vi.advanceTimersByTime(1))
    expect(onDraft).toHaveBeenLastCalledWith("")
    expect(passing().on).toBe(false)
  })

  it("goes after Enter where the box never read at all", () => {
    const { passing, rerender, onDraft } = setup()
    act(() => passing().edit("/model"))
    rerender({ ...given, draft: "/model" })
    act(() => void passing().press("\r"))
    act(() => void vi.advanceTimersByTime(boxLagMs))
    expect(onDraft).toHaveBeenLastCalledWith("")
  })

  it("keeps what the box keeps after Enter, and says Enter ran nothing", () => {
    const { passing, rerender, onDraft, onKept } = setup({ agent: "agy" })
    act(() => passing().edit("/re"))
    rerender({ ...given, agent: "agy", draft: "/re", box: box("/re") })
    act(() => void passing().press("\r"))
    rerender({ ...given, agent: "agy", draft: "/re", box: box("/remote-control") })
    act(() => void vi.advanceTimersByTime(0))
    expect(onDraft).toHaveBeenLastCalledWith("/remote-control")
    expect(passing().on).toBe(true)
    expect(onKept).toHaveBeenCalled()
  })

  it("goes on from the box as the chat comes back to a menu", () => {
    const { passing, onDraft } = setup({ box: box("/mo"), slice: slice("menu") })
    act(() => void vi.advanceTimersByTime(0))
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
