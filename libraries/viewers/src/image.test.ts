import "./image.css"
import { afterEach, describe, expect, it } from "vitest"

import { mountImage, type ImageContent } from "./image.js"

// An image of a size, which loads as a real one does: after mounting.
const picture = (width: number, height: number): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`,
  )}`

const large = { src: picture(1600, 1200), alt: "A screenshot" }

const hosts: HTMLElement[] = []
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove()
})

const hostIn = (): HTMLElement => {
  const host = document.createElement("div")
  host.style.cssText = "display: flex; flex-direction: column; height: 300px; width: 400px"
  document.body.append(host)
  hosts.push(host)
  return host
}

const viewerOf = (host: HTMLElement): HTMLElement => host.querySelector(".image-viewer")!
const imageOf = (host: HTMLElement): HTMLImageElement => host.querySelector("img")!
const loaded = async (host: HTMLElement): Promise<void> => {
  await expect.poll(() => imageOf(host).complete && imageOf(host).naturalWidth > 0).toBe(true)
}

const mount = (content: ImageContent, host = hostIn(), zooms: boolean[] = []) =>
  mountImage(host, { content, label: "screenshot.png", onZoom: (actual) => zooms.push(actual) })

describe("the image viewer", () => {
  it("shows the image fitted, under its name", () => {
    const host = hostIn()
    const zooms: boolean[] = []
    mount(large, host, zooms)
    expect(viewerOf(host).getAttribute("aria-label")).toBe("screenshot.png")
    expect(imageOf(host).alt).toBe("A screenshot")
    expect(viewerOf(host).hasAttribute("data-actual")).toBe(false)
    expect(zooms).toEqual([false])
  })

  it("fits the image to its width, and shows it at its own size when zoomed", async () => {
    const host = hostIn()
    const zooms: boolean[] = []
    const viewer = mount(large, host, zooms)
    await loaded(host)
    expect(imageOf(host).getBoundingClientRect().width).toBeLessThanOrEqual(400)
    viewer.zoom(true)
    expect(viewerOf(host).hasAttribute("data-actual")).toBe(true)
    expect(imageOf(host).getBoundingClientRect().width).toBe(1600)
    expect(viewerOf(host).scrollWidth).toBeGreaterThan(viewerOf(host).clientWidth)
    expect(zooms).toEqual([false, true])
  })

  it("picks up its zoom and place from its state, though its image loads after", async () => {
    const first = hostIn()
    const viewer = mount(large, first)
    await loaded(first)
    viewer.zoom(true)
    viewerOf(first).scrollTop = 500
    viewerOf(first).scrollLeft = 300
    const state = viewer.state()
    viewer.destroy()
    expect(first.children).toHaveLength(0)

    // A new viewer whose image hasn't loaded yet: its size arrives with it.
    const zooms: boolean[] = []
    const again = hostIn()
    mountImage(again, {
      content: large,
      label: "screenshot.png",
      saved: state,
      onZoom: (actual) => zooms.push(actual),
    })
    expect(zooms).toEqual([true])
    await expect.poll(() => viewerOf(again).scrollTop).toBe(500)
    expect(viewerOf(again).scrollLeft).toBe(300)
  })

  it("holds its place until its image has loaded, however long that takes", async () => {
    const first = hostIn()
    const viewer = mount(large, first)
    await loaded(first)
    viewer.zoom(true)
    viewerOf(first).scrollTop = 500
    const state = viewer.state()
    viewer.destroy()

    // An image that takes longer to load than the moment a place is held for once ready.
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!
    let done = false
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => done,
    })
    try {
      const host = hostIn()
      mountImage(host, { content: large, label: "screenshot.png", saved: state })
      await expect.poll(() => viewerOf(host).scrollTop).toBe(500)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      done = true
      // Tall enough that nothing scrolls, then back: still held, the place comes back.
      host.style.height = "3000px"
      await expect.poll(() => viewerOf(host).scrollTop).toBe(0)
      // Seen at that size before the next: a resize observer reports only what a frame saw.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      host.style.height = "300px"
      await expect.poll(() => viewerOf(host).scrollTop).toBe(500)
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, "complete", complete)
    }
  })

  it("takes no zoom or place from another image's state", async () => {
    const first = hostIn()
    const viewer = mount(large, first)
    viewer.zoom(true)
    const state = viewer.state()
    viewer.destroy()
    const second = hostIn()
    mountImage(second, { content: { src: picture(10, 10), alt: "" }, label: "x", saved: state })
    expect(viewerOf(second).hasAttribute("data-actual")).toBe(false)
  })

  it("keeps its zoom for a new image, and takes a new description in place", () => {
    const host = hostIn()
    const viewer = mount(large, host)
    viewer.zoom(true)
    const image = imageOf(host)
    viewer.update({ ...large, alt: "The same screenshot" })
    expect(imageOf(host)).toBe(image)
    expect(image.alt).toBe("The same screenshot")
    const other = picture(800, 600)
    viewer.update({ src: other, alt: "Another" })
    expect(image.src).toBe(other)
    expect(viewerOf(host).hasAttribute("data-actual")).toBe(true)
  })

  it("takes focus without scrolling", () => {
    const host = hostIn()
    mount(large, host).focus()
    expect(document.activeElement).toBe(viewerOf(host))
  })
})
