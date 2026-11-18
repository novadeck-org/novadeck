import type {
  AudioContent,
  Companions,
  ItemContent,
  UnavailableReason,
  FilePart,
} from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { Shown } from "@novadeck/toolkit/shown"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { stateOf, stubMedia } from "../video/media-stub"
import { playable } from "../video/playable"
import { audio as registration } from "./index"
import { usePeaks } from "./peaks"

// jsdom decodes nothing: every recording plays, unless a test says its bytes don't.
vi.mock("../video/playable", () => ({
  playable: vi.fn<(blob: Blob, kind?: "video" | "audio") => Promise<boolean>>(async () => true),
}))
afterEach(() => vi.mocked(playable).mockReset().mockResolvedValue(true))

// The waveform's peaks as the player asks for them: of which file, by its stamp and URL.
vi.mock("./peaks", async (original) => {
  const peaks = await original<typeof import("./peaks")>()
  return { ...peaks, usePeaks: vi.fn<typeof peaks.usePeaks>(peaks.usePeaks) }
})
const peaksAsked = () => vi.mocked(usePeaks).mock.calls.map(([{ stamp, url }]) => ({ stamp, url }))

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

stubMedia("audio")

const target = { projectId: "project", workspaceSessionId: "initial" }
let ids = 0

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

type Show = {
  readonly container: HTMLElement
  readonly unmount: () => void
  readonly show: (content: Partial<AudioContent>, stamp?: string, file?: number[]) => void
  readonly element: () => HTMLAudioElement
  // The recording knows its length now.
  readonly ready: (duration: number) => void
  readonly rerender: (visible: boolean) => void
}

// The recording in the pane, over a file of `file` bytes the backend reads in parts of two.
const shown = async ({
  file = [1, 2, 3, 4, 5],
  content = {},
  stamp = "1",
  part,
  id = `voice${++ids}`,
}: {
  id?: string
  file?: number[]
  content?: Partial<AudioContent>
  stamp?: string
  part?: Companions["part"] | null
} = {}): Promise<Show> => {
  const item = itemFixture(id, "01", { kind: "audio", name: "voiceover.mp3", path: "/p/v.mp3" })
  let bytes = file
  const parts: Companions["part"] = async (_target, _id, { offset }) => ({
    state: "part",
    bytes: Uint8Array.from(bytes.slice(offset, offset + 2)),
  })
  let emit: (content: ItemContent) => void = () => {}
  const ready = (fields: Partial<AudioContent>, at: string): ItemContent => ({
    state: "ready",
    stamp: at,
    content: { kind: "audio", mime: "audio/mpeg", size: bytes.length, shown: 1, ...fields },
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
  const view = (visible: boolean) =>
    createElement(
      Shown,
      { value: visible },
      createElement(registration.View, { item, itemStore, target }),
    )
  const rendered = render(view(true))
  unmounts.push(rendered.unmount)
  await settle()
  const element = () => rendered.container.querySelector("audio")!
  return {
    container: rendered.container,
    unmount: rendered.unmount,
    element,
    rerender: (visible) => rendered.rerender(view(visible)),
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
      .querySelector(".audio-player")!
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
const wave = (container: HTMLElement) => container.querySelector<HTMLElement>(".wave")!

describe("a recording beside a terminal", () => {
  context("while its bytes are read", () => {
    it("says how much is in, and shows no player until all of it is", async () => {
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
      expect(container.querySelector(".audio-loading")!.textContent).toContain(
        "Loading 1.0 of 4.0 MB",
      )
      expect(container.querySelector("audio")).toBeNull()
      release({ state: "part", bytes: new Uint8Array(0) })
      await settle()
      expect(container.querySelector("audio")).not.toBeNull()
    })

    it("tries the bytes on an audio element, and plays from the blob of all the parts", async () => {
      const { element } = await shown()
      expect(playable).toHaveBeenCalledWith(expect.any(Blob), "audio")
      expect(element().getAttribute("src")).toMatch(/^blob:audio-/)
    })
  })

  context("when it can't load", () => {
    it("says it can't be played here where the backend can't read it in parts", async () => {
      const { container } = await shown({ part: null })
      expect(container.textContent).toContain("voiceover.mp3 can't be played here")
    })

    it("says so when the browser can't decode what it read, before or after it plays", async () => {
      vi.mocked(playable).mockResolvedValueOnce(false)
      const first = await shown()
      expect(first.container.querySelector(".artifact-status")!.textContent).toContain(
        "can't be played here",
      )
      const { container, element } = await shown()
      act(() => {
        element().dispatchEvent(new Event("error"))
      })
      expect(container.querySelector(".artifact-status")).not.toBeNull()
      expect(container.querySelector("audio")).toBeNull()
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

  context("as a card, not a picture", () => {
    it("names the file, and gives its format, size and length once known", async () => {
      const { container, ready } = await shown({ content: { size: 4.2 * 1024 * 1024 } })
      expect(container.querySelector(".audio-name")!.textContent).toBe("voiceover.mp3")
      expect(container.querySelector(".audio-facts")!.textContent).toBe("MP3 · 4.2 MB")
      ready(92)
      expect(container.querySelector(".audio-facts")!.textContent).toBe("MP3 · 4.2 MB · 1:32")
      expect(container.querySelector("video")).toBeNull()
    })

    it("draws a flat waveform where the browser can't decode peaks, which still scrubs", async () => {
      const { container, element, ready } = await shown()
      ready(100)
      expect(wave(container).getAttribute("data-peaks")).toBe("none")
      expect(wave(container).querySelectorAll(".wave-bar").length).toBeGreaterThan(0)
      act(() => {
        wave(container).dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
      })
      expect(element().currentTime).toBe(100)
    })
  })

  context("when its pane comes back", () => {
    it("plays the recording it loaded before without reading it again", async () => {
      const first = await shown({ id: "back", stamp: "same", file: [1, 2] })
      const src = first.element().getAttribute("src")
      first.unmount()
      const spy = vi.fn<NonNullable<Companions["part"]>>()
      const again = await shown({ id: "back", stamp: "same", file: [1, 2], part: spy })
      expect(spy).not.toHaveBeenCalled()
      expect(again.element().getAttribute("src")).toBe(src)
    })

    it("finds it where it was, with its loop, speed and mute", async () => {
      const first = await shown({ id: "place", stamp: "p", file: [1, 2] })
      first.ready(30)
      act(() => {
        first.element().currentTime = 12
      })
      click(first.container, "Loop")
      click(first.container, "Mute")
      act(() => first.container.querySelector<HTMLButtonElement>("[data-control=speed]")!.click())
      first.unmount()
      const again = await shown({ id: "place", stamp: "p", file: [1, 2] })
      again.ready(30)
      expect(again.element().currentTime).toBe(12)
      expect(again.element().loop).toBe(true)
      expect(again.element().muted).toBe(true)
      expect(again.element().playbackRate).toBe(1.5)
    })
  })

  context("with its own controls", () => {
    it("plays and pauses, with the button and with Space", async () => {
      const { container, element, ready } = await shown()
      ready(40)
      click(container, "Play")
      expect(element().paused).toBe(false)
      expect(control(container, "Pause")).not.toBeNull()
      press(container, " ")
      expect(element().paused).toBe(true)
    })

    it("shows the time, and seeks from the waveform", async () => {
      const { container, element, ready } = await shown()
      ready(125)
      expect(container.querySelector(".audio-time")!.textContent).toBe("0:00.00 / 2:05")
      act(() => {
        wave(container).dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        )
      })
      expect(element().currentTime).toBe(5)
      expect(container.querySelector(".audio-time")!.textContent).toBe("0:05.00 / 2:05")
      expect(wave(container).getAttribute("aria-valuetext")).toBe("0:05 of 2:05")
    })

    it("jumps 5 seconds with the arrow keys of the player, never past either end", async () => {
      const { container, element, ready } = await shown()
      ready(8)
      press(container, "ArrowRight")
      press(container, "ArrowRight")
      expect(element().currentTime).toBe(8)
      press(container, "ArrowLeft")
      expect(element().currentTime).toBe(3)
      press(container, "ArrowLeft")
      expect(element().currentTime).toBe(0)
    })

    it("loops and mutes, by button and by key", async () => {
      const { container, element, ready } = await shown()
      ready(10)
      click(container, "Loop")
      expect(element().loop).toBe(true)
      press(container, "l")
      expect(element().loop).toBe(false)
      click(container, "Mute")
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
    })

    it("has no frame steps and no full screen, and leaves their keys alone", async () => {
      const { container, element, ready } = await shown()
      ready(10)
      expect(
        [...container.querySelectorAll("button")].map((each) => each.getAttribute("aria-label")),
      ).toEqual(["Play", "Loop", "Speed 1×", "Mute"])
      for (const key of [",", ".", "f"]) press(container, key)
      expect(element().currentTime).toBe(0)
      expect(element().paused).toBe(true)
    })

    it("pauses when the pane goes out of sight", async () => {
      const { container, element, ready, rerender } = await shown()
      ready(10)
      click(container, "Play")
      expect(element().paused).toBe(false)
      rerender(false)
      expect(element().paused).toBe(true)
    })
  })

  context("when the file is rewritten", () => {
    it("plays on where it was, paused or playing", async () => {
      const { container, element, show, ready } = await shown({ stamp: "a1" })
      ready(10)
      act(() => {
        element().currentTime = 4
      })
      click(container, "Play")
      show({}, "a2", [9, 8, 7])
      await settle()
      expect(element().currentTime).toBe(0)
      ready(6)
      expect(element().currentTime).toBe(4)
      expect(element().paused).toBe(false)
    })

    it("draws the waveform of the file it plays, the old one while the new one loads", async () => {
      let release: (part: FilePart) => void = () => {}
      let hold = false
      const { element, show } = await shown({
        stamp: "w1",
        part: (_target, _id, { offset }) =>
          hold && offset === 0
            ? new Promise((resolve) => (release = resolve))
            : Promise.resolve({ state: "part", bytes: Uint8Array.from([1, 2]) }),
        content: { size: 2 },
      })
      const before = element().getAttribute("src")!
      hold = true
      vi.mocked(usePeaks).mockClear()
      show({}, "w2")
      await settle()
      expect(peaksAsked().at(-1)).toEqual({ stamp: "w1", url: before })
      release({ state: "part", bytes: Uint8Array.from([3, 4]) })
      await settle()
      expect(peaksAsked().at(-1)).toEqual({ stamp: "w2", url: element().getAttribute("src") })
    })

    it("plays on where it was when the new file can't play yet", async () => {
      const { container, element, show, ready } = await shown({ stamp: "e1" })
      ready(10)
      act(() => {
        element().currentTime = 4
      })
      click(container, "Play")
      const before = element().getAttribute("src")
      vi.mocked(playable).mockResolvedValueOnce(false)
      show({}, "e2", [])
      await settle()
      expect(element().getAttribute("src")).toBe(before)
      expect(element().paused).toBe(false)
      expect(container.querySelector(".artifact-status")).toBeNull()
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
      show({ at: 3 }, "1")
      expect(element().currentTime).toBe(9)
      show({ shown: 2, at: 14 }, "1")
      expect(element().currentTime).toBe(14)
    })
  })

  context("in its peek", () => {
    it("says its format and size, reading none of its bytes", async () => {
      const item = itemFixture(`thumb${++ids}`, "01", { kind: "audio", name: "voiceover.mp3" })
      const stamp: ItemContent = {
        state: "ready",
        stamp: "1",
        content: { kind: "audio", mime: "audio/mpeg", size: 4.2 * 1024 * 1024, shown: 1 },
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
      expect(container.textContent).toContain("MP3")
      expect(container.textContent).toContain("4.2 MB")
      expect(part).not.toHaveBeenCalled()
    })
  })
})
