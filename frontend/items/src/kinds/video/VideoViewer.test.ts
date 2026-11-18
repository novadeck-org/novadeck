import type {
  Companions,
  ItemContent,
  UnavailableReason,
  VideoContent,
  FilePart,
} from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { video as registration } from "./index"
import { stateOf, stubMedia } from "./media-stub"
import { playable } from "./playable"
import { timing } from "./source"

// jsdom decodes nothing: every video plays, unless a test says its bytes don't.
vi.mock("./playable", () => ({
  playable: vi.fn<(blob: Blob) => Promise<boolean>>(async () => true),
}))
afterEach(() => vi.mocked(playable).mockReset().mockResolvedValue(true))

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

stubMedia("video")

const target = { projectId: "project", workspaceSessionId: "initial" }
let ids = 0

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

type Show = {
  readonly parts: number[]
  readonly asked: { offset: number; stamp: string; reveal: string | undefined }[]
  readonly container: HTMLElement
  readonly unmount: () => void
  readonly show: (content: Partial<VideoContent>, stamp?: string, file?: number[]) => void
  readonly element: () => HTMLVideoElement
  // The video knows its length now.
  readonly ready: (duration: number) => void
}

// The video item in the pane, over a file of `file` bytes the backend reads in parts of two.
const shown = async ({
  file = [1, 2, 3, 4, 5],
  content = {},
  stamp = "1",
  part,
  secret = false,
  id = `clip${++ids}`,
}: {
  id?: string
  file?: number[]
  content?: Partial<VideoContent>
  stamp?: string
  part?: Companions["part"] | null
  secret?: boolean
} = {}): Promise<Show> => {
  const item = itemFixture(id, "01", {
    kind: "video",
    name: "demo.mp4",
    path: "/p/demo.mp4",
    secret,
  })
  let bytes = file
  const asked: Show["asked"] = []
  const parts: Companions["part"] = async (_target, _id, { stamp: read, offset, reveal }) => {
    asked.push({ offset, stamp: read, reveal })
    return { state: "part", bytes: Uint8Array.from(bytes.slice(offset, offset + 2)) }
  }
  let emit: (content: ItemContent) => void = () => {}
  const ready = (fields: Partial<VideoContent>, at: string): ItemContent => ({
    state: "ready",
    stamp: at,
    content: { kind: "video", mime: "video/mp4", size: bytes.length, shown: 1, ...fields },
  })
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      emit = on
      on(ready(content, stamp))
      return () => {}
    },
    save: () => new Promise(() => {}),
    trouble: () => {},
    ...(part === null ? {} : { part: part ?? parts }),
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item }),
  )
  const itemStore = createItemStore({ companions, workspace })
  unmounts.push(itemStore.connect())
  const rendered = render(createElement(registration.View, { item, itemStore, target }))
  unmounts.push(rendered.unmount)
  await settle()
  const element = () => rendered.container.querySelector("video")!
  return {
    parts: [],
    asked,
    container: rendered.container,
    unmount: rendered.unmount,
    element,
    show: (next, at = "2", replacement) => {
      if (replacement) bytes = replacement
      act(() => emit(ready({ ...content, ...next }, at)))
    },
    ready: (duration) => {
      stateOf(element()).duration = duration
      act(() => {
        element().dispatchEvent(new Event("loadedmetadata"))
      })
    },
  }
}

const control = (container: HTMLElement, label: string): HTMLButtonElement =>
  container.querySelector(`button[aria-label="${label}"]`)!
const click = (container: HTMLElement, label: string) =>
  act(() => control(container, label).click())
const press = (container: HTMLElement, key: string) =>
  act(() => {
    container
      .querySelector(".video-player")!
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
const scrub = (container: HTMLElement) => container.querySelector<HTMLInputElement>(".video-scrub")!

describe("a video beside a terminal", () => {
  context("while its bytes are read", () => {
    it("says how much is in, and plays nothing until all of it is", async () => {
      let release: (part: FilePart) => void = () => {}
      let calls = 0
      const { container } = await shown({
        file: [1, 2, 3, 4],
        content: { size: 4 * 1024 * 1024 },
        part: () =>
          ++calls === 1
            ? Promise.resolve({ state: "part", bytes: new Uint8Array(1024 * 1024) })
            : new Promise((resolve) => (release = resolve)),
      })
      expect(container.querySelector(".video-loading")!.textContent).toContain(
        "Loading 1.0 of 4.0 MB",
      )
      expect(container.querySelector("video")).toBeNull()
      expect(container.querySelector(".video-viewer")!.getAttribute("aria-busy")).toBe("true")
      release({ state: "part", bytes: new Uint8Array(0) })
      await settle()
      expect(container.querySelector("video")).not.toBeNull()
    })

    it("plays from the blob of all the parts, read from the stamp it was shown at", async () => {
      const { container, asked, element } = await shown({ stamp: "7" })
      expect(asked).toEqual([
        { offset: 0, stamp: "7", reveal: undefined },
        { offset: 2, stamp: "7", reveal: undefined },
        { offset: 4, stamp: "7", reveal: undefined },
      ])
      expect(element().getAttribute("src")).toMatch(/^blob:video-/)
      expect(container.querySelector(".video-loading")).toBeNull()
    })
  })

  context("when it can't load", () => {
    it("says it can't be played here where the backend can't read it in parts", async () => {
      const { container } = await shown({ part: null })
      expect(container.textContent).toContain("can't be played here")
    })

    it("says so when the read fails", async () => {
      const { container } = await shown({ part: () => Promise.reject(new Error("gone")) })
      expect(container.textContent).toContain("couldn't be loaded")
    })

    it("says it can't be played here when the browser can't decode what it read", async () => {
      const { container, element } = await shown()
      act(() => {
        element().dispatchEvent(new Event("error"))
      })
      expect(container.querySelector(".artifact-status")!.textContent).toContain(
        "demo.mp4 can't be played here",
      )
      expect(container.querySelector("video")).toBeNull()
    })

    it.each<[UnavailableReason & ("missing" | "too-large" | "secret"), string]>([
      ["missing", "isn't there any more"],
      ["too-large", "too large"],
      ["secret", "may hold secrets"],
    ])("says in words why the file is %s", async (reason, words) => {
      const { container } = await shown({
        part: async () => ({ state: "unavailable", reason }),
      })
      expect(container.querySelector(".artifact-unavailable")!.textContent).toContain(words)
    })
  })

  context("when its pane comes back", () => {
    it("plays the video it loaded before without reading it again", async () => {
      const first = await shown({ id: "back", stamp: "same", file: [1, 2] })
      expect(first.asked.length).toBeGreaterThan(0)
      const src = first.element().getAttribute("src")
      first.unmount()
      const again = await shown({ id: "back", stamp: "same", file: [1, 2] })
      expect(again.asked).toEqual([])
      expect(again.element().getAttribute("src")).toBe(src)
    })

    it("reads it again once the file has changed", async () => {
      const first = await shown({ id: "back-changed", stamp: "one", file: [1, 2] })
      first.unmount()
      const again = await shown({ id: "back-changed", stamp: "two", file: [1, 2] })
      expect(again.asked.length).toBeGreaterThan(0)
    })

    it("plays on through a rewrite after it came back, never emptying the pane", async () => {
      const first = await shown({ id: "back-rewrite", stamp: "r1", file: [1, 2] })
      const src = first.element().getAttribute("src")
      first.unmount()
      const again = await shown({ id: "back-rewrite", stamp: "r1", file: [1, 2] })
      again.ready(10)
      act(() => {
        again.element().currentTime = 4
      })
      click(again.container, "Play")
      again.show({}, "r2", [9, 8, 7])
      // The video it came back to plays while the new file is read.
      expect(again.element().getAttribute("src")).toBe(src)
      await settle()
      expect(again.element().getAttribute("src")).not.toBe(src)
      again.ready(6)
      expect(again.element().currentTime).toBe(4)
      expect(again.element().paused).toBe(false)
    })

    it("plays the item's latest file when it comes back to one newer than it read", async () => {
      const first = await shown({ id: "back-newer", stamp: "n1", file: [1, 2] })
      const src = first.element().getAttribute("src")
      first.unmount()
      let release: (part: FilePart) => void = () => {}
      const again = await shown({
        id: "back-newer",
        stamp: "n2",
        part: () => new Promise((resolve) => (release = resolve)),
        content: { size: 2 },
      })
      expect(again.element().getAttribute("src")).toBe(src)
      release({ state: "part", bytes: Uint8Array.from([3, 4]) })
      await settle()
      expect(again.element().getAttribute("src")).not.toBe(src)
    })

    it("finds the video where it was, with its loop and speed", async () => {
      const first = await shown({ id: "place", stamp: "p", file: [1, 2] })
      first.ready(30)
      act(() => {
        first.element().currentTime = 12
      })
      click(first.container, "Loop")
      act(() => first.container.querySelector<HTMLButtonElement>("[data-control=speed]")!.click())
      first.unmount()
      const again = await shown({ id: "place", stamp: "p", file: [1, 2] })
      again.ready(30)
      expect(again.element().currentTime).toBe(12)
      expect(again.element().loop).toBe(true)
      expect(again.element().playbackRate).toBe(1.5)
      // It was shown at its first show already: no second is started again.
      expect(control(again.container, "Loop").getAttribute("aria-pressed")).toBe("true")
    })
  })

  context("with its own controls", () => {
    it("plays and pauses, with the button and with Space", async () => {
      const { container, element, ready } = await shown()
      ready(40)
      expect(control(container, "Play")).not.toBeNull()
      click(container, "Play")
      expect(element().paused).toBe(false)
      expect(control(container, "Pause")).not.toBeNull()
      press(container, " ")
      expect(element().paused).toBe(true)
    })

    it("shows the time, and seeks from the scrubber", async () => {
      const { container, element, ready } = await shown()
      ready(125)
      expect(container.querySelector(".video-time")!.textContent).toBe("0:00.00 / 2:05")
      act(() => {
        const input = scrub(container)
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "63")
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      expect(element().currentTime).toBe(63)
      expect(container.querySelector(".video-time")!.textContent).toBe("1:03.00 / 2:05")
      expect(scrub(container).getAttribute("aria-valuetext")).toBe("1:03 of 2:05")
    })

    it("jumps 5 seconds with the arrow keys, never past either end", async () => {
      const { container, element, ready } = await shown()
      ready(12)
      press(container, "ArrowRight")
      press(container, "ArrowRight")
      press(container, "ArrowRight")
      expect(element().currentTime).toBe(12)
      press(container, "ArrowLeft")
      expect(element().currentTime).toBe(7)
      press(container, "ArrowLeft")
      press(container, "ArrowLeft")
      expect(element().currentTime).toBe(0)
    })

    it("steps a frame, a thirtieth of a second, pausing first", async () => {
      const { container, element, ready } = await shown()
      ready(10)
      click(container, "Play")
      click(container, "Forward one frame")
      expect(element().paused).toBe(true)
      expect(element().currentTime).toBeCloseTo(1 / 30)
      press(container, ".")
      press(container, ",")
      press(container, ",")
      // Not before its start.
      expect(element().currentTime).toBe(0)
      click(container, "Back one frame")
      expect(element().currentTime).toBe(0)
    })

    it("loops and mutes, by button and by key, and shows them on", async () => {
      const { container, element, ready } = await shown()
      ready(10)
      expect(control(container, "Loop").getAttribute("aria-pressed")).toBe("false")
      click(container, "Loop")
      expect(element().loop).toBe(true)
      press(container, "l")
      expect(element().loop).toBe(false)
      press(container, "L")
      expect(element().loop).toBe(true)
      click(container, "Mute")
      expect(element().muted).toBe(true)
      expect(control(container, "Mute").getAttribute("aria-pressed")).toBe("true")
      press(container, "m")
      expect(element().muted).toBe(false)
    })

    it("steps through its speeds, round again to half", async () => {
      const { container, element, ready } = await shown()
      ready(10)
      const seen: number[] = []
      for (let each = 0; each < 5; each += 1) {
        seen.push(element().playbackRate)
        act(() => container.querySelector<HTMLButtonElement>("[data-control=speed]")!.click())
      }
      expect(seen).toEqual([1, 1.5, 2, 0.5, 1])
      expect(container.querySelector("[data-control=speed]")!.getAttribute("aria-label")).toBe(
        "Speed 1.5×",
      )
    })

    it("goes full screen on the player and back, by button and by key", async () => {
      const { container, ready } = await shown()
      ready(10)
      const player = container.querySelector<HTMLElement>(".video-player")!
      const request = vi.fn<() => Promise<void>>(async () => {})
      Object.assign(player, { requestFullscreen: request })
      click(container, "Full screen")
      press(container, "f")
      expect(request).toHaveBeenCalledTimes(2)
      const exit = vi.fn<() => Promise<void>>(async () => {})
      Object.assign(document, { exitFullscreen: exit })
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => player,
      })
      try {
        act(() => {
          document.dispatchEvent(new Event("fullscreenchange"))
        })
        click(container, "Exit full screen")
        expect(exit).toHaveBeenCalled()
      } finally {
        Reflect.deleteProperty(document, "fullscreenElement")
      }
    })

    it("names every control and gives it a tooltip's key, and leaves other keys and a focused button's Space alone", async () => {
      const { container, element, ready } = await shown()
      ready(10)
      const names = [...container.querySelectorAll("button")].map((each) =>
        each.getAttribute("aria-label"),
      )
      expect(names).toEqual([
        "Play",
        "Back one frame",
        "Forward one frame",
        "Loop",
        "Speed 1×",
        "Mute",
        "Full screen",
      ])
      press(container, "x")
      expect(element().paused).toBe(true)
      // A key on a button is the button's.
      const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })
      act(() => {
        control(container, "Loop").dispatchEvent(event)
      })
      expect(event.defaultPrevented).toBe(false)
      expect(element().paused).toBe(true)
    })
  })

  context("when the file is rewritten", () => {
    it("loads the new bytes and plays on where it was, paused or playing", async () => {
      const { container, element, show, ready, asked } = await shown({ stamp: "a1" })
      ready(10)
      act(() => {
        element().currentTime = 4
      })
      click(container, "Play")
      show({}, "a2", [9, 8, 7])
      await settle()
      expect(asked.at(-1)).toMatchObject({ stamp: "a2" })
      // The element is emptied by its new source, and tells its length again.
      expect(element().currentTime).toBe(0)
      ready(6)
      expect(element().currentTime).toBe(4)
      expect(element().paused).toBe(false)
    })

    it("holds it to the new length, and keeps it paused if it was", async () => {
      const { element, show, ready } = await shown({ stamp: "b1" })
      ready(10)
      act(() => {
        element().currentTime = 9
      })
      show({}, "b2", [1, 2, 3])
      await settle()
      ready(3)
      expect(element().currentTime).toBe(3)
      expect(element().paused).toBe(true)
    })

    it("keeps the old video playing while the new one loads", async () => {
      let release: (part: FilePart) => void = () => {}
      let hold = false
      const { container, element, show } = await shown({
        stamp: "c1",
        part: (_target, _id, { offset }) =>
          hold && offset === 0
            ? new Promise((resolve) => (release = resolve))
            : Promise.resolve({ state: "part", bytes: Uint8Array.from([1, 2]) }),
        content: { size: 2 },
      })
      const before = element().getAttribute("src")
      hold = true
      show({}, "c2")
      await settle()
      expect(element().getAttribute("src")).toBe(before)
      expect(container.querySelector(".video-loading")!.getAttribute("data-over")).toBe("true")
      release({ state: "part", bytes: Uint8Array.from([3, 4]) })
      await settle()
      expect(element().getAttribute("src")).not.toBe(before)
    })

    it("plays on where it was when the new file can't play yet, as one rewritten in place", async () => {
      const { container, element, show, ready } = await shown({ stamp: "e1" })
      ready(10)
      act(() => {
        element().currentTime = 4
      })
      click(container, "Play")
      const before = element().getAttribute("src")
      // Caught while its render wrote it: empty, or without its index yet.
      vi.mocked(playable).mockResolvedValueOnce(false)
      show({}, "e2", [])
      await settle()
      expect(element().getAttribute("src")).toBe(before)
      expect(element().currentTime).toBe(4)
      expect(element().paused).toBe(false)
      expect(container.querySelector(".artifact-status")).toBeNull()
      // The render's end swaps in where it was.
      show({}, "e3", [9, 8, 7])
      await settle()
      expect(element().getAttribute("src")).not.toBe(before)
      ready(6)
      expect(element().currentTime).toBe(4)
      expect(element().paused).toBe(false)
    })

    it("says it can't be played here when the first file it read can't play", async () => {
      vi.mocked(playable).mockResolvedValueOnce(false)
      const { container } = await shown()
      expect(container.querySelector(".artifact-status")!.textContent).toContain(
        "demo.mp4 can't be played here",
      )
    })

    it("waits for a file rewritten while it plays to settle, reading only where it ends", async () => {
      timing.settleMs = 40
      const { show, asked, element } = await shown({ stamp: "s1" })
      const before = element().getAttribute("src")
      show({}, "s2", [9, 8, 7])
      await settle()
      show({}, "s3", [6, 5, 4])
      await settle()
      expect(asked.filter(({ stamp }) => stamp !== "s1")).toEqual([])
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 80)))
      expect([...new Set(asked.map(({ stamp }) => stamp))]).toEqual(["s1", "s3"])
      expect(element().getAttribute("src")).not.toBe(before)
    })

    it("starts afresh when it was changed while it was read", async () => {
      let changes = 1
      const asked: { stamp: string; offset: number }[] = []
      const { element, show } = await shown({
        stamp: "d1",
        part: async (_target, _id, { stamp, offset }) => {
          asked.push({ offset, stamp })
          return stamp === "d1" && changes-- > 0
            ? { state: "changed" }
            : { state: "part", bytes: Uint8Array.from([1, 2]) }
        },
        content: { size: 2 },
      })
      expect(element()).toBeNull()
      show({}, "d2")
      await settle()
      expect(asked.map(({ stamp, offset }) => `${stamp}@${offset}`)).toEqual(["d1@0", "d2@0"])
      expect(element().getAttribute("src")).toMatch(/^blob:/)
    })
  })

  context("when the agent shows it again", () => {
    it("starts it at the second the show names, once for each show", async () => {
      const { element, show, ready } = await shown({ content: { at: 3 } })
      ready(20)
      expect(element().currentTime).toBe(3)
      act(() => {
        element().currentTime = 9
      })
      // The same show reported again leaves it where the person took it.
      show({ at: 3 }, "1")
      expect(element().currentTime).toBe(9)
      show({ shown: 2, at: 14 }, "1")
      expect(element().currentTime).toBe(14)
    })

    it("starts a new render at the second its show names, not the file before it", async () => {
      const { element, show, ready } = await shown({ stamp: "s1" })
      ready(8)
      act(() => {
        element().currentTime = 5
      })
      const before = element().getAttribute("src")
      show({ shown: 2, at: 12 }, "s2", [6, 7, 8])
      // The file before plays on where it is while the new one is read.
      expect(element().currentTime).toBe(5)
      await settle()
      expect(element().getAttribute("src")).not.toBe(before)
      ready(20)
      expect(element().currentTime).toBe(12)
      // Showing it again as it is leaves it where the person takes it.
      act(() => {
        element().currentTime = 3
      })
      show({ shown: 2, at: 12 }, "s2")
      expect(element().currentTime).toBe(3)
    })

    it("leaves it where it is when the show names no second", async () => {
      const { element, show, ready } = await shown()
      ready(20)
      act(() => {
        element().currentTime = 6
      })
      show({ shown: 2 }, "1")
      expect(element().currentTime).toBe(6)
    })
  })

  context("in its peek", () => {
    it("says its format and size, reading none of its bytes", async () => {
      const item = itemFixture(`thumb${++ids}`, "01", { kind: "video", name: "demo.mp4" })
      const stamp: ItemContent = {
        state: "ready",
        stamp: "1",
        content: { kind: "video", mime: "video/mp4", size: 12.3 * 1024 * 1024, shown: 1 },
      }
      const part = vi.fn<NonNullable<Companions["part"]>>()
      const companions: Companions = {
        follow: (_target, _id, _options, on) => {
          on(stamp)
          return () => {}
        },
        save: () => new Promise(() => {}),
        trouble: () => {},
        part,
      }
      const workspace = createWorkspaceStore(
        workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item }),
      )
      const itemStore = createItemStore({ companions, workspace })
      unmounts.push(itemStore.connect())
      const { container } = render(createElement(registration.Thumb, { item, itemStore, target }))
      await settle()
      expect(container.textContent).toContain("MP4")
      expect(container.textContent).toContain("12.3 MB")
      expect(part).not.toHaveBeenCalled()
    })
  })
})
