import { noConversation, type ChatItem, type Conversation } from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import {
  createPanePictures,
  firstMs,
  pageLook,
  PanePicturesContext,
  type PanePictures,
} from "@novadeck/items/pane-pictures"
import { createPaneTurns, PaneTurnsContext, type Pace } from "@novadeck/items/pane-turns"
import { render } from "@novadeck/test-kit/render"
import { Shown, useShown } from "@novadeck/toolkit/shown"
import { act } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { ChatTurn } from "./chat-turn"

const said = (id: string, text: string): ChatItem => ({
  id,
  at: null,
  role: "assistant",
  kind: "text",
  text,
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  outcome: null,
  scripted: false,
  interrupted: false,
  ring: null,
})

// Turns that come as the test steps.
const stepped = () => {
  const queue: (() => void)[] = []
  const pace: Pace = (next) => {
    queue.push(next)
    return () => {
      const at = queue.indexOf(next)
      if (at >= 0) queue.splice(at, 1)
    }
  }
  return { turns: createPaneTurns(pace), step: () => act(() => queue.shift()?.()) }
}

// Pictures kept as the app keeps them, each taken at once (a test's document lays everything
// out at 0 by 0).
const picturing = (): PanePictures => ({
  ...createPanePictures(undefined),
  can: () => true,
  take: async () => {
    const image = document.createElement("img")
    image.src = "data:image/jpeg;base64,AAAA"
    return { image, width: 0, height: 0, look: pageLook() }
  },
})

// What the chat would draw: whether it's told it's in sight.
const Chat = (): React.JSX.Element => (
  <div className="chat" data-in-sight={String(useShown())}>
    chat
  </div>
)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("a chat in its turn", () => {
  const conversation = createStore<Conversation>({
    ...noConversation,
    session: "s",
    loaded: true,
    items: [said("s:0", "First words")],
  })
  // The chat of terminal T in a workspace whose turns and pictures are `turns` and `pictures`.
  const open = (
    turns: ReturnType<typeof stepped>["turns"],
    pictures: PanePictures = picturing(),
    inSight = true,
    { atOnce = false, drawn = "" }: { atOnce?: boolean; drawn?: string } = {},
  ) => {
    const element = (shown: boolean) => (
      <PaneTurnsContext value={turns}>
        <PanePicturesContext value={pictures}>
          <Shown value={shown}>
            <ChatTurn
              first
              name="T"
              conversation={conversation}
              picturedAs="chat:grid:T"
              drawn={drawn}
              atOnce={atOnce}
            >
              <Chat />
            </ChatTurn>
          </Shown>
        </PanePicturesContext>
      </PaneTurnsContext>
    )
    const page = render(element(inSight))
    return {
      ...page,
      show: (shown: boolean) => page.rerender(element(shown)),
    }
  }
  const standIn = (container: HTMLElement) => container.querySelector(".chat-stand-in")
  const chat = (container: HTMLElement) => container.querySelector<HTMLElement>(".chat")
  const picture = (container: HTMLElement) =>
    container.querySelector(".chat-stand-in .pane-stand-in-picture")

  it("stands in as its terminal's name until its turn, then builds", () => {
    const { turns, step } = stepped()
    const { container } = open(turns)
    expect(standIn(container)?.getAttribute("aria-label")).toBe("Opening the chat of T")
    expect(chat(container)).toBeNull()
    step()
    expect(standIn(container)).toBeNull()
    expect(chat(container)?.dataset.inSight).toBe("true")
  })

  it("builds at once where it comes over a screen already in sight", () => {
    const { turns, step } = stepped()
    const { container, show } = open(turns, undefined, true, { atOnce: true })
    expect(standIn(container)).toBeNull()
    expect(chat(container)?.dataset.inSight).toBe("true")
    step()
    show(false)
    show(true)
    // Back into sight, it waits its turn all the same.
    expect(chat(container)?.dataset.inSight).toBe("false")
    step()
    expect(chat(container)?.dataset.inSight).toBe("true")
  })

  it("stands in as its name where what the app draws in it changed since its picture", async () => {
    const pictures = picturing()
    const first = stepped()
    const before = open(first.turns, pictures, true, { drawn: "a draft" })
    first.step()
    await act(async () => void (await vi.advanceTimersByTimeAsync(firstMs)))
    before.unmount()

    const again = open(stepped().turns, pictures, true, { drawn: "" })
    expect(standIn(again.container)).not.toBeNull()
    expect(picture(again.container)).toBeNull()
  })

  it("comes back into sight as it was, and is told it's in sight in its turn", () => {
    const { turns, step } = stepped()
    const { container, show } = open(turns)
    step()
    show(false)
    show(true)
    expect(standIn(container)).toBeNull()
    expect(chat(container)?.dataset.inSight).toBe("false")
    step()
    expect(chat(container)?.dataset.inSight).toBe("true")
  })

  it("stands in as its picture from the last time this view showed it, nothing new since", async () => {
    const pictures = picturing()
    const first = stepped()
    const before = open(first.turns, pictures)
    first.step()
    await act(async () => void (await vi.advanceTimersByTimeAsync(firstMs)))
    before.unmount()

    const again = open(stepped().turns, pictures)
    expect(standIn(again.container)?.getAttribute("data-pictured")).toBe("true")
    expect(picture(again.container)).not.toBeNull()
  })

  it("stands in as its name where its conversation changed since its picture", async () => {
    const pictures = picturing()
    const first = stepped()
    const before = open(first.turns, pictures)
    first.step()
    await act(async () => void (await vi.advanceTimersByTimeAsync(firstMs)))
    before.unmount()
    act(
      () =>
        void conversation.update((now) => ({
          ...now,
          items: [...now.items, said("s:1", "More words")],
        })),
    )

    const again = open(stepped().turns, pictures)
    expect(standIn(again.container)).not.toBeNull()
    expect(picture(again.container)).toBeNull()
  })
})
