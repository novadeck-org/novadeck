import { noConversation, type ChatBox, type Conversation } from "@novadeck/core/conversation"
import { createStore, type MutableStore } from "@novadeck/core/store"
import { render } from "@novadeck/test-kit/render"
import { act, createElement, useEffect, useState } from "react"

import { describe, expect, it } from "./test"
import { useBoxHandover } from "./use-box-handover"

const box = (text: string, tail = false): ChatBox => ({
  text,
  mode: "prompt",
  tail,
  known: false,
})

const setup = () => {
  const store: MutableStore<Conversation> = createStore<Conversation>(noConversation)
  const moves = { takes: 0, puts: 0, show: (_shown: boolean): void => {} }
  const Host = () => {
    const [shown, setShown] = useState(true)
    useEffect(() => void (moves.show = setShown), [])
    useBoxHandover(shown ? store : undefined, {
      take: () => void (moves.takes += 1),
      put: () => void (moves.puts += 1),
    })
    return null
  }
  render(createElement(Host))
  return {
    store,
    moves,
    show: (shown: boolean) => act(() => moves.show(shown)),
    say: (next: ChatBox | null) => act(() => store.update((now) => ({ ...now, box: next }))),
  }
}

describe("useBoxHandover", () => {
  it("takes what the box comes to hold, once per text, however often it's told", () => {
    const { moves, say } = setup()
    expect(moves.takes).toBe(0)
    say(box("words"))
    say(box("words"))
    expect(moves.takes).toBe(1)
    say(box("more words"))
    expect(moves.takes).toBe(2)
  })

  it("tries a text again only once the box held something else", () => {
    const { moves, say } = setup()
    say(box("words"))
    say(null)
    say(box("words"))
    expect(moves.takes).toBe(2)
  })

  it("leaves a box that may show only a tail", () => {
    const { moves, say } = setup()
    say(box("the end of it", true))
    expect(moves.takes).toBe(0)
  })

  it("puts the draft back only as the terminal comes to show", () => {
    const { moves, show } = setup()
    expect(moves.puts).toBe(0)
    show(false)
    expect(moves.puts).toBe(1)
    show(false)
    expect(moves.puts).toBe(1)
    show(true)
    expect(moves.puts).toBe(1)
  })

  it("takes nothing while the terminal shows, and what the box holds as the chat comes back", () => {
    const { moves, say, show } = setup()
    show(false)
    say(box("typed in the terminal"))
    expect(moves.takes).toBe(0)
    show(true)
    expect(moves.takes).toBe(1)
  })
})
