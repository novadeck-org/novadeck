import type { ChatImage } from "@novadeck/core/conversation"
import type { ChatBlock } from "@novadeck/core/conversation/turns"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import type { Attachment } from "./attachments"
import { context, describe, expect, it } from "./test"
import { createThumbCache } from "./thumb-cache"
import { labelsOf, ThumbsContext, type Thumbs } from "./Thumbs"
import { Transcript } from "./Transcript"

const images: readonly ChatImage[] = [
  { offset: 100, index: 0, mime: "image/png" },
  { offset: 100, index: 1, mime: "image/png" },
]
const prompt: ChatBlock = {
  kind: "user",
  id: "s:3",
  text: "Compare [Image #4] with [Image #5]",
  truncated: false,
  at: null,
  images,
}

const preview = (name: string): Attachment => ({
  id: name,
  n: 1,
  name,
  preview: `blob:${name}`,
  state: "ready",
  path: `/up/${name}`,
  error: null,
})

const show = (thumbs: Partial<Thumbs>, blocks: readonly ChatBlock[] = [prompt]) =>
  render(
    createElement(
      ThumbsContext.Provider,
      {
        value: {
          fetch: undefined,
          cache: createThumbCache(),
          previews: () => undefined,
          ...thumbs,
        },
      },
      createElement(Transcript, { blocks, agent: "Claude", working: false }),
    ),
  ).container

const settle = () => act(() => Promise.resolve())

afterEach(() => vi.unstubAllGlobals())

describe("the images of a recorded prompt", () => {
  context("named by their placeholders", () => {
    it("take the words' own where there are as many, else their place", () => {
      expect(labelsOf("See [Image #4] and [Image #5]", 2)).toEqual(["Image #4", "Image #5"])
      expect(labelsOf("See [Image #4]", 2)).toEqual(["Image 1", "Image 2"])
      expect(labelsOf("See it", 1)).toEqual(["Image 1"])
    })
  })

  it("show as thumbnails on the prompt's row, its words staying as they are", async () => {
    const fetch = vi.fn<(image: ChatImage) => Promise<string>>(
      async (image) => `data:image/png;base64,${image.index}`,
    )
    const container = show({ fetch })
    await settle()
    const row = container.querySelector("article")!
    expect(
      [...row.querySelectorAll(".chat-images img")].map((img) => img.getAttribute("src")),
    ).toEqual(["data:image/png;base64,0", "data:image/png;base64,1"])
    expect(
      [...row.querySelectorAll(".chat-images img")].map((img) => img.getAttribute("alt")),
    ).toEqual(["Image #4", "Image #5"])
    expect(row.querySelector(".chat-text")?.textContent).toBe("Compare [Image #4] with [Image #5]")
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("show this window's own previews at once, asking the backend for nothing", async () => {
    const fetch = vi.fn<(image: ChatImage) => Promise<string>>(
      async () => "data:image/png;base64,AAAA",
    )
    const container = show({
      fetch,
      previews: (item) => (item === "s:3" ? [preview("a"), preview("b")] : undefined),
    })
    await settle()
    expect(
      [...container.querySelectorAll(".chat-images img")].map((img) => img.getAttribute("src")),
    ).toEqual(["blob:a", "blob:b"])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("ask for a preview this window let go of", async () => {
    const fetch = vi.fn<(image: ChatImage) => Promise<string>>(
      async () => "data:image/png;base64,AAAA",
    )
    const container = show({ fetch, previews: () => [preview("a"), preview("b")] })
    const first = container.querySelector<HTMLImageElement>(".chat-images img")!
    act(() => void first.dispatchEvent(new Event("error")))
    await settle()
    expect(container.querySelector(".chat-images img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("wait for a quiet box while a picture comes, then take its place", async () => {
    let resolve: (src: string) => void = () => {}
    const fetch = vi.fn<(image: ChatImage) => Promise<string | null>>(
      () => new Promise<string | null>((done) => (resolve = done)),
    )
    const container = show({ fetch }, [{ ...prompt, images: [images[0]!] }])
    expect(container.querySelector(".chat-image-none")?.getAttribute("data-state")).toBe("wait")
    expect(container.querySelector(".chat-images img")).toBeNull()
    resolve("data:image/png;base64,AAAA")
    await settle()
    expect(container.querySelector(".chat-image-none")).toBeNull()
    expect(container.querySelector(".chat-images img")).not.toBeNull()
  })

  it("name themselves where the picture can't be shown", async () => {
    const fetch = vi.fn<(image: ChatImage) => Promise<string | null>>(async (image) => {
      if (image.index === 0) return null
      throw new Error("offline")
    })
    const container = show({ fetch })
    await settle()
    expect(
      [...container.querySelectorAll(".chat-image-none")].map((box) => box.textContent),
    ).toEqual(["Image #4", "Image #5"])
    expect(container.querySelector(".chat-images button")).toBeNull()
  })

  it("name themselves where the backend can't find a picture again", () => {
    const container = show({})
    expect(
      [...container.querySelectorAll(".chat-image-none")].map((box) => box.textContent),
    ).toEqual(["Image #4", "Image #5"])
  })

  it("are asked for only once their row nears the view", async () => {
    const watching: { callback: IntersectionObserverCallback; target: Element }[] = []
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          watching.push({ callback: this.callback, target })
        }
        disconnect() {}
      },
    )
    const fetch = vi.fn<(image: ChatImage) => Promise<string>>(
      async () => "data:image/png;base64,AAAA",
    )
    const container = show({ fetch })
    await settle()
    expect(fetch).not.toHaveBeenCalled()
    expect(container.querySelectorAll(".chat-image-none[data-state='wait']")).toHaveLength(2)
    act(() =>
      watching[0]!.callback(
        [{ isIntersecting: true, target: watching[0]!.target } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    )
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll(".chat-images img")).toHaveLength(1)
  })

  it("keep their pictures for the chat's life, so a row drawn again asks for none", async () => {
    const fetch = vi.fn<(image: ChatImage) => Promise<string>>(
      async () => "data:image/png;base64,AAAA",
    )
    const cache = createThumbCache()
    const first = show({ fetch, cache })
    await settle()
    first.remove()
    const again = show({ fetch, cache })
    expect(again.querySelectorAll(".chat-images img")).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("open larger in the image viewer when clicked, and close with Escape", async () => {
    // jsdom draws nothing, so the viewer has nothing to watch the size of.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const container = show({ fetch: async () => "data:image/png;base64,AAAA" }, [
      { ...prompt, text: "Look at [Image #4]", images: [images[0]!] },
    ])
    await settle()
    expect(document.querySelector("[role='dialog']")).toBeNull()
    const open = container.querySelector<HTMLButtonElement>(".chat-images button")!
    expect(open.getAttribute("aria-label")).toBe("View Image #4")
    act(() => open.click())
    await settle()
    const dialog = document.querySelector("[role='dialog']")!
    expect(dialog.getAttribute("aria-label")).toBe("Image #4")
    expect(dialog.querySelector(".image-viewer img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    )
    act(
      () =>
        void dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    )
    await settle()
    expect(document.querySelector("[role='dialog'][data-state='open']")).toBeNull()
  })

  it("are not asked for again when the chat draws again with a new way to ask", async () => {
    const cache = createThumbCache()
    const first = vi.fn<(image: ChatImage) => Promise<string>>(
      async () => "data:image/png;base64,AAAA",
    )
    const later = vi.fn<(image: ChatImage) => Promise<string>>(
      async () => "data:image/png;base64,BBBB",
    )
    const around = (fetch: Thumbs["fetch"]) =>
      createElement(
        ThumbsContext.Provider,
        { value: { fetch, cache, previews: () => undefined } },
        createElement(Transcript, { blocks: [prompt], agent: "Claude", working: false }),
      )
    const view = render(around(first))
    await settle()
    view.rerender(around(later))
    await settle()
    expect(first).toHaveBeenCalledTimes(2)
    expect(later).not.toHaveBeenCalled()
    expect(view.container.querySelectorAll(".chat-images img")).toHaveLength(2)
  })

  it("are not asked for again within the backoff after a failure, drawn again or not", async () => {
    const cache = createThumbCache()
    const fetch = vi.fn<(image: ChatImage) => Promise<string | null>>(async () => {
      throw new Error("offline")
    })
    const around = (ask: Thumbs["fetch"]) =>
      createElement(
        ThumbsContext.Provider,
        { value: { fetch: ask, cache, previews: () => undefined } },
        createElement(Transcript, { blocks: [prompt], agent: "Claude", working: false }),
      )
    const view = render(around(fetch))
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    view.rerender(around(async () => null))
    view.unmount()
    show({ fetch, cache })
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("ask for the picture instead when this window's preview is gone by the time it is clicked", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("revoked")
    })
    const fetch = vi.fn<(image: ChatImage) => Promise<string>>(
      async () => "data:image/png;base64,AAAA",
    )
    const container = show({ fetch, previews: () => [preview("a")] }, [
      { ...prompt, text: "Look at [Image #4]", images: [images[0]!] },
    ])
    const open = container.querySelector<HTMLButtonElement>(".chat-images button")!
    act(() => open.click())
    await settle()
    expect(document.querySelector("[role='dialog']")).toBeNull()
    expect(container.querySelector(".chat-images img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("name the box a picture is coming in, and close from a control as well as Escape", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    let resolve: (src: string) => void = () => {}
    const fetch = vi.fn<(image: ChatImage) => Promise<string | null>>(
      () => new Promise<string | null>((done) => (resolve = done)),
    )
    const container = show({ fetch }, [
      { ...prompt, text: "Look at [Image #4]", images: [images[0]!] },
    ])
    expect(container.querySelector("[data-state='wait']")?.getAttribute("aria-label")).toBe(
      "Loading Image #4",
    )
    resolve("data:image/png;base64,AAAA")
    await settle()
    act(() => container.querySelector<HTMLButtonElement>(".chat-images button")!.click())
    await settle()
    const close = document.querySelector<HTMLButtonElement>("[role='dialog'] .chat-image-close")!
    expect(close.getAttribute("aria-label")).toBe("Close image")
    act(() => close.click())
    await settle()
    expect(document.querySelector("[role='dialog'][data-state='open']")).toBeNull()
  })
})
