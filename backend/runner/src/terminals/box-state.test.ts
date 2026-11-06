import { setTimeout as sleep } from "node:timers/promises"

import { screen } from "@novadeck/harness-core/testing/screens"
import type { AgentBox } from "@novadeck/protocol"
import type { BoxProfile, InputBox } from "@novadeck/tui-input/box"
import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { boxView, BoxStates } from "./box-state.js"
import { holdsRingLine } from "./leftover.js"

const profile = (read: InputBox | undefined, over: Partial<BoxProfile> = {}): BoxProfile => ({
  read: () => read,
  stands: () => false,
  textWidth: (columns) => columns - 3,
  collapsed: () => false,
  shell: { expands: true, starts: false, footer: () => false },
  overlay: () => false,
  queued: () => false,
  collapses: () => false,
  room: (rows) => rows - 3,
  ...over,
})

const box = (text: string, mode: InputBox["mode"] = "prompt"): InputBox => ({
  text,
  mode,
  first: 1,
  last: 1,
})

const shown = screen({ rows: Array<string>(10).fill("") })
const never = () => false

describe("boxView", () => {
  it("shows what the box holds, its mode, and whether it may be a tail", () => {
    expect(boxView(profile(box("half typed ")), shown, never, never)).toEqual({
      text: "half typed",
      mode: "prompt",
      tail: false,
      known: false,
    })
    expect(boxView(profile(box("ls", "shell")), shown, never, never)).toMatchObject({
      mode: "shell",
    })
    expect(boxView(profile(box("/help")), shown, never, never)?.text).toBe("/help")
    const viewport = () => 1
    const tall = profile({ ...box("c"), last: 2 }, { viewport: () => 2 })
    expect(boxView(tall, shown, never, never)?.tail).toBe(true)
    const cut = profile(box("↑ 10 more lines\nc"), { cut: () => true })
    expect(boxView(cut, shown, never, never)?.tail).toBe(true)
    expect(boxView(profile(box("c"), { viewport }), shown, never, never)?.tail).toBe(false)
  })

  it("says when it's all Novadeck's words", () => {
    expect(boxView(profile(box("came back")), shown, () => true, never)?.known).toBe(true)
  })

  it("shows nothing for an empty box, no box, a view, an empty shell mode or a ring's line", () => {
    expect(boxView(profile(box("")), shown, never, never)).toBeNull()
    expect(boxView(profile(undefined), shown, never, never)).toBeNull()
    expect(boxView(profile(box("x"), { overlay: () => true }), shown, never, never)).toBeNull()
    expect(boxView(profile(box("", "shell")), shown, never, never)).toBeNull()
    expect(boxView(profile(box("line")), shown, never, () => true)).toBeNull()
  })

  it("cuts a text past what the wire carries", () => {
    const long = "x".repeat(20_000)
    expect(boxView(profile(box(long)), shown, never, never)?.text).toHaveLength(16_384)
  })
})

describe("BoxStates", () => {
  const words: AgentBox = { text: "words", mode: "prompt", tail: false, known: false }

  const states = (over: { watched?: boolean; typing?: boolean } = {}) => {
    let current: AgentBox | null | undefined = words
    let typing = over.typing ?? false
    const changed = vi.fn<(terminalId: string) => void>()
    const read = vi.fn<() => Promise<AgentBox | null | undefined>>(() => Promise.resolve(current))
    const boxes = new BoxStates(
      { watched: () => over.watched ?? true, typing: () => typing, read, changed },
      { throttleMs: 5 },
    )
    return {
      boxes,
      changed,
      read,
      show: (next: AgentBox | null | undefined) => (current = next),
      typing: (now: boolean) => (typing = now),
    }
  }

  it("reads no screen no one watches", async () => {
    const { boxes, read } = states({ watched: false })
    boxes.changed("t")
    await sleep(20)
    expect(read).not.toHaveBeenCalled()
    expect(boxes.view("t")).toBeNull()
  })

  it("announces a change, and only a change", async () => {
    const { boxes, changed, show } = states()
    boxes.changed("t")
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(boxes.view("t")).toEqual(words)
    boxes.changed("t")
    await sleep(20)
    expect(changed).toHaveBeenCalledTimes(1)
    show(null)
    boxes.changed("t")
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(boxes.view("t")).toBeNull()
    boxes.close()
  })

  it("throttles a burst of changes into one look", async () => {
    const { boxes, read } = states()
    for (let at = 0; at < 20; at += 1) boxes.changed("t")
    await sleep(20)
    expect(read).toHaveBeenCalledTimes(1)
    boxes.close()
  })

  it("reads nothing while something is typing there, and looks once it's done", async () => {
    const { boxes, read, typing } = states({ typing: true })
    boxes.changed("t")
    await sleep(20)
    expect(read).not.toHaveBeenCalled()
    typing(false)
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    boxes.close()
  })

  it("takes a screen gone for nothing to show", async () => {
    const { boxes, show, changed } = states()
    boxes.changed("t")
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    show(undefined)
    boxes.changed("t")
    await vi.waitFor(() => expect(boxes.view("t")).toBeNull())
    boxes.close()
  })

  it("forgets a terminal no client reads any more", async () => {
    let watched = true
    const read = vi.fn<() => Promise<AgentBox>>(() => Promise.resolve(words))
    const boxes = new BoxStates(
      { watched: () => watched, typing: () => false, read, changed: () => {} },
      { throttleMs: 1 },
    )
    boxes.changed("t")
    await vi.waitFor(() => expect(boxes.view("t")).toEqual(words))
    watched = false
    boxes.changed("t")
    expect(boxes.view("t")).toBeNull()
  })
})

describe("holdsRingLine", () => {
  it("finds a ring's line, wrapped or beside the person's words, and no words alone", () => {
    expect(holdsRingLine("[Novadeck: automatic notice, agent\nmessages waiting, abc]")).toBe(true)
    expect(holdsRingLine("my words [Novadeck Inbox reply, abc] hello [abc]")).toBe(true)
    expect(holdsRingLine("my words about Novadeck")).toBe(false)
  })
})
