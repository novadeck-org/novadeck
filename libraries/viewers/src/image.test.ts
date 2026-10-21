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
const chipOf = (host: HTMLElement): HTMLButtonElement => host.querySelector(".image-zoom")!
const loaded = async (host: HTMLElement): Promise<void> => {
  await expect.poll(() => viewerOf(host).hasAttribute("data-sized")).toBe(true)
}

// Where the image is drawn in its viewer.
const placeOf = (host: HTMLElement) => {
  const viewer = viewerOf(host).getBoundingClientRect()
  const image = imageOf(host).getBoundingClientRect()
  return {
    x: image.left - viewer.left,
    y: image.top - viewer.top,
    width: image.width,
    height: image.height,
  }
}

// A point in the viewer, as the page has it.
const at = (host: HTMLElement, x: number, y: number) => {
  const viewer = viewerOf(host).getBoundingClientRect()
  return { clientX: viewer.left + x, clientY: viewer.top + y }
}

const wheel = (host: HTMLElement, init: WheelEventInit): WheelEvent => {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init })
  viewerOf(host).dispatchEvent(event)
  return event
}

const key = (host: HTMLElement, name: string): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })
  viewerOf(host).dispatchEvent(event)
  return event
}

const mount = (content: ImageContent, host = hostIn()) =>
  mountImage(host, { content, label: "screenshot.png" })

describe("the image viewer", () => {
  it("shows the image fitted whole, under its name, with no zoom to show", async () => {
    const host = hostIn()
    mount(large, host)
    expect(viewerOf(host).getAttribute("aria-label")).toBe("screenshot.png")
    expect(imageOf(host).alt).toBe("A screenshot")
    await loaded(host)
    const place = placeOf(host)
    // Inside the viewer's 20px padding, both ways: 360 × 260 fits 1600 × 1200 at 260 high.
    expect(place.height).toBeCloseTo(260)
    expect(place.width).toBeCloseTo(346.67, 1)
    expect(place.x).toBe(Math.round((400 - place.width) / 2))
    expect(chipOf(host).hidden).toBe(true)
    expect(viewerOf(host).hasAttribute("data-pannable")).toBe(false)
  })

  it("never enlarges an image to fit it", async () => {
    const host = hostIn()
    mount({ src: picture(40, 30), alt: "" }, host)
    await loaded(host)
    expect(placeOf(host).width).toBe(40)
  })

  it("shows the image at its own size at 100%, its zoom over it", async () => {
    const host = hostIn()
    const viewer = mount(large, host)
    await loaded(host)
    viewer.zoom(1)
    expect(placeOf(host).width).toBe(1600)
    expect(viewerOf(host).hasAttribute("data-pannable")).toBe(true)
    expect(chipOf(host).hidden).toBe(false)
    expect(chipOf(host).textContent).toBe("100%")
    expect(chipOf(host).getAttribute("aria-label")).toBe("Zoomed to 100%. Back to fit")
    // Centred: the middle of the image at the middle of the viewer.
    expect(placeOf(host).x).toBe(200 - 800)
    expect(placeOf(host).y).toBe(150 - 600)
  })

  it("zooms around the pointer with Ctrl and the wheel, or a pinch, never the page", async () => {
    const host = hostIn()
    const viewer = mount(large, host)
    await loaded(host)
    // Zoomed in already, so no edge holds the image where it zooms.
    viewer.zoom(0.5)
    const before = placeOf(host)
    // The image's point under the pointer, as a share of its size.
    const pointer = { x: 120, y: 90 }
    const under = (place: typeof before) => ({
      x: (pointer.x - place.x) / place.width,
      y: (pointer.y - place.y) / place.height,
    })
    const event = wheel(host, { deltaY: -100, ctrlKey: true, ...at(host, pointer.x, pointer.y) })
    expect(event.defaultPrevented).toBe(true)
    const after = placeOf(host)
    // A notch is about 15%, however far it turned.
    expect(after.width / before.width).toBeCloseTo(Math.exp(0.15), 3)
    expect(under(after).x).toBeCloseTo(under(before).x, 2)
    expect(under(after).y).toBeCloseTo(under(before).y, 2)
    expect(chipOf(host).textContent).toBe("58%")

    // A pinch's small step zooms as far as it went.
    wheel(host, { deltaY: -5, ctrlKey: true, ...at(host, pointer.x, pointer.y) })
    expect(placeOf(host).width / after.width).toBeCloseTo(Math.exp(0.05), 3)
  })

  it("stops at fit zooming out, and goes back to fit there", async () => {
    const host = hostIn()
    const viewer = mount(large, host)
    await loaded(host)
    const fitted = placeOf(host)
    viewer.zoom(0.3)
    for (let turn = 0; turn < 20; turn += 1) wheel(host, { deltaY: 100, ctrlKey: true })
    expect(placeOf(host)).toEqual(fitted)
    expect(chipOf(host).hidden).toBe(true)
    // Zooming out at fit is still the image's, not the page's.
    expect(wheel(host, { deltaY: 100, ctrlKey: true }).defaultPrevented).toBe(true)
  })

  it("stops at 3200% zooming in, its pixels square from 400%", async () => {
    const host = hostIn()
    const viewer = mount({ src: picture(10, 10), alt: "" }, host)
    await loaded(host)
    viewer.zoom(3)
    expect(viewerOf(host).hasAttribute("data-pixelated")).toBe(false)
    viewer.zoom(4)
    expect(viewerOf(host).hasAttribute("data-pixelated")).toBe(true)
    viewer.zoom(100)
    expect(placeOf(host).width).toBe(320)
    expect(chipOf(host).textContent).toBe("3200%")
  })

  it("moves a zoomed image with the wheel, sideways with Shift, but lets a fitted one be", async () => {
    const host = hostIn()
    const viewer = mount(large, host)
    await loaded(host)
    expect(wheel(host, { deltaY: 100 }).defaultPrevented).toBe(false)

    viewer.zoom(1)
    const start = placeOf(host)
    expect(wheel(host, { deltaY: 100 }).defaultPrevented).toBe(true)
    expect(placeOf(host).y).toBe(start.y - 100)
    wheel(host, { deltaY: 100, shiftKey: true })
    expect(placeOf(host).x).toBe(start.x - 100)
    // A trackpad moves it both ways at once.
    wheel(host, { deltaX: -30, deltaY: -40 })
    expect(placeOf(host)).toMatchObject({ x: start.x - 70, y: start.y - 60 })
  })

  it("never moves an edge in past the viewer's", async () => {
    const host = hostIn()
    const viewer = mount(large, host)
    await loaded(host)
    viewer.zoom(1)
    wheel(host, { deltaX: -5000, deltaY: -5000 })
    expect(placeOf(host)).toMatchObject({ x: 0, y: 0 })
    wheel(host, { deltaX: 5000, deltaY: 5000 })
    expect(placeOf(host)).toMatchObject({ x: 400 - 1600, y: 300 - 1200 })
  })

  it("centres a zoomed image on an axis it still fits", async () => {
    const host = hostIn()
    const viewer = mount({ src: picture(1600, 100), alt: "" }, host)
    await loaded(host)
    viewer.zoom(1)
    wheel(host, { deltaY: 500 })
    expect(placeOf(host).y).toBe(100)
  })

  it("moves with a drag", async () => {
    const host = hostIn()
    const viewer = mount(large, host)
    await loaded(host)
    viewer.zoom(1)
    const start = placeOf(host)
    const pointer = (type: string, x: number, y: number) =>
      viewerOf(host).dispatchEvent(
        new PointerEvent(type, { pointerId: 7, button: 0, bubbles: true, ...at(host, x, y) }),
      )
    pointer("pointerdown", 200, 150)
    expect(viewerOf(host).hasAttribute("data-panning")).toBe(true)
    pointer("pointermove", 230, 110)
    pointer("pointermove", 250, 100)
    pointer("pointerup", 250, 100)
    expect(placeOf(host)).toMatchObject({ x: start.x + 50, y: start.y - 50 })
    expect(viewerOf(host).hasAttribute("data-panning")).toBe(false)
    pointer("pointermove", 300, 200)
    expect(placeOf(host)).toMatchObject({ x: start.x + 50, y: start.y - 50 })
    expect(document.activeElement).toBe(viewerOf(host))
  })

  it("goes to 100% where double-clicked, and back to fit", async () => {
    const host = hostIn()
    mount(large, host)
    await loaded(host)
    const fitted = placeOf(host)
    const point = { x: 100, y: 100 }
    const share = (point.x - fitted.x) / fitted.width
    viewerOf(host).dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, ...at(host, point.x, point.y) }),
    )
    const zoomed = placeOf(host)
    expect(zoomed.width).toBe(1600)
    expect((point.x - zoomed.x) / zoomed.width).toBeCloseTo(share, 2)
    viewerOf(host).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    expect(placeOf(host)).toEqual(fitted)
  })

  it("doubles an image that fits at its own size, double-clicked", async () => {
    const host = hostIn()
    mount({ src: picture(40, 30), alt: "" }, host)
    await loaded(host)
    viewerOf(host).dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, ...at(host, 200, 150) }),
    )
    expect(placeOf(host).width).toBe(80)
  })

  it("zooms and moves by keys", async () => {
    const host = hostIn()
    mount(large, host)
    await loaded(host)
    const fitted = placeOf(host)
    // Nothing to move while it fits: the arrow is left to the page.
    expect(key(host, "ArrowRight").defaultPrevented).toBe(false)
    expect(key(host, "+").defaultPrevented).toBe(true)
    expect(placeOf(host).width).toBeCloseTo(fitted.width * 1.25, 1)
    key(host, "-")
    expect(placeOf(host)).toEqual(fitted)
    key(host, "1")
    const actual = placeOf(host)
    expect(actual.width).toBe(1600)
    expect(key(host, "ArrowRight").defaultPrevented).toBe(true)
    expect(placeOf(host).x).toBe(actual.x - 40)
    key(host, "0")
    expect(placeOf(host)).toEqual(fitted)
    // With Ctrl, the app's shortcut rather than the image's.
    const shortcut = new KeyboardEvent("keydown", { key: "1", ctrlKey: true, cancelable: true })
    viewerOf(host).dispatchEvent(shortcut)
    expect(shortcut.defaultPrevented).toBe(false)
    expect(placeOf(host)).toEqual(fitted)
  })

  it("goes back to fit from its zoom", async () => {
    const host = hostIn()
    const viewer = mount(large, host)
    await loaded(host)
    const fitted = placeOf(host)
    viewer.zoom(2)
    chipOf(host).click()
    expect(placeOf(host)).toEqual(fitted)
    expect(chipOf(host).hidden).toBe(true)
  })

  it("keeps the point at its centre as its viewer is resized, and fits again at fit", async () => {
    const host = hostIn()
    const viewer = mount(large, host)
    await loaded(host)
    viewer.zoom(1)
    wheel(host, { deltaX: 300, deltaY: 200 })
    const centre = (width: number, height: number) => {
      const place = placeOf(host)
      return { x: (width / 2 - place.x) / place.width, y: (height / 2 - place.y) / place.height }
    }
    const before = centre(400, 300)
    host.style.width = "600px"
    host.style.height = "500px"
    await expect.poll(() => centre(600, 500).x).toBeCloseTo(before.x, 3)
    expect(centre(600, 500).y).toBeCloseTo(before.y, 3)

    key(host, "0")
    host.style.width = "800px"
    await expect.poll(() => placeOf(host).width).toBeCloseTo(613.33, 1)
  })

  it("picks up its zoom and view from its state, though its image loads after", async () => {
    const first = hostIn()
    const viewer = mount(large, first)
    await loaded(first)
    viewer.zoom(1.5)
    wheel(first, { deltaX: 300, deltaY: -200 })
    const left = placeOf(first)
    const state = viewer.state()
    viewer.destroy()
    expect(first.children).toHaveLength(0)

    // A new viewer whose image hasn't loaded yet: its view arrives with it.
    const again = hostIn()
    mountImage(again, { content: large, label: "screenshot.png", saved: state })
    await loaded(again)
    expect(placeOf(again)).toEqual(left)
    expect(chipOf(again).textContent).toBe("150%")
  })

  it("picks up its view once it has a size, mounted out of sight", async () => {
    const first = hostIn()
    const viewer = mount(large, first)
    await loaded(first)
    viewer.zoom(1)
    wheel(first, { deltaX: 200 })
    const left = placeOf(first)
    const state = viewer.state()
    viewer.destroy()

    const hidden = hostIn()
    hidden.style.display = "none"
    mountImage(hidden, { content: large, label: "screenshot.png", saved: state })
    await expect.poll(() => imageOf(hidden).complete).toBe(true)
    expect(viewerOf(hidden).hasAttribute("data-sized")).toBe(false)
    hidden.style.display = "flex"
    await loaded(hidden)
    expect(placeOf(hidden)).toEqual(left)
  })

  it("takes no zoom or view from another image's state", async () => {
    const first = hostIn()
    const viewer = mount(large, first)
    await loaded(first)
    viewer.zoom(1)
    const state = viewer.state()
    viewer.destroy()
    const second = hostIn()
    mountImage(second, { content: { src: picture(1000, 1000), alt: "" }, label: "x", saved: state })
    await loaded(second)
    expect(chipOf(second).hidden).toBe(true)
  })

  it("keeps its zoom for a new image, and takes a new description in place", async () => {
    const host = hostIn()
    const viewer = mount(large, host)
    await loaded(host)
    viewer.zoom(1)
    const image = imageOf(host)
    viewer.update({ ...large, alt: "The same screenshot" })
    expect(imageOf(host)).toBe(image)
    expect(image.alt).toBe("The same screenshot")
    const other = picture(800, 600)
    viewer.update({ src: other, alt: "Another" })
    expect(image.src).toBe(other)
    await expect.poll(() => placeOf(host).width).toBe(800)
    expect(chipOf(host).textContent).toBe("100%")
  })

  it("shows a broken image as any page would, with nothing to zoom", async () => {
    const host = hostIn()
    mount({ src: "data:image/png;base64,broken", alt: "Gone" }, host)
    await expect.poll(() => imageOf(host).complete).toBe(true)
    expect(viewerOf(host).hasAttribute("data-sized")).toBe(false)
    expect(imageOf(host).style.width).toBe("")
    expect(chipOf(host).hidden).toBe(true)
  })

  it("takes focus without scrolling", () => {
    const host = hostIn()
    mount(large, host).focus()
    expect(document.activeElement).toBe(viewerOf(host))
  })
})
