import { htmlSamples, stripAgain, stripGround } from "@novadeck/demo/showcase/html-samples"
import { page } from "vitest/browser"

import { buildStudioShows } from "../support/backend"
import { companionPane, openShowcase } from "../support/companions"
import { describe, expect, it } from "../test"

// The colour at (x, y) of `element` as the browser draws it, from a screenshot of it: what a
// frame of no origin drew, which the app's page can't read.
const colorAt = async (element: HTMLElement, x: number, y: number): Promise<string> => {
  const base64 = await page.screenshot({ element, save: false })
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
  const canvas = new OffscreenCanvas(image.width, image.height)
  const context = canvas.getContext("2d")!
  context.drawImage(image, 0, 0)
  const [r, g, b] = context.getImageData(x, y, 1, 1).data
  return `#${[r, g, b].map((part) => part!.toString(16).padStart(2, "0")).join("")}`
}

const open = async () => {
  await openShowcase("focus")
  buildStudioShows(htmlSamples.shown)
  const pane = companionPane("Build Studio")
  await expect.element(pane.getByRole("tab", { name: "strip.html" })).toBeVisible()
  return pane
}

describe("An HTML file an agent shows", () => {
  it("is drawn in the pane as a page, in a sandboxed frame, styled by the file beside it", async () => {
    const pane = await open()
    const frame = pane.getByTitle("strip.html")
    await expect.element(frame).toBeVisible()
    await expect.element(frame).toHaveAttribute("sandbox", "allow-scripts")
    // Its stylesheet is the one beside it: the cream ground it gives the page.
    await expect.poll(async () => colorAt(frame.element() as HTMLElement, 4, 4)).toBe(stripGround)
  })

  it("is drawn again as its stylesheet is written again", async () => {
    const pane = await open()
    const frame = pane.getByTitle("strip.html")
    await expect.poll(async () => colorAt(frame.element() as HTMLElement, 4, 4)).toBe(stripGround)
    buildStudioShows(stripAgain("rewritten-1", "#dfe9f3"))
    await expect
      .poll(async () => colorAt(frame.element() as HTMLElement, 4, 4), { timeout: 5000 })
      .toBe("#dfe9f3")
  })

  it("shows its source in the code viewer once switched to it, and the page again after", async () => {
    const pane = await open()
    await expect.element(pane.getByTitle("strip.html")).toBeVisible()
    await pane.getByRole("button", { name: "Show source" }).click()
    await expect
      .poll(() => pane.element().querySelector(".code-viewer")?.textContent)
      .toContain("<h1>Monday, in three panels</h1>")
    expect(pane.getByTitle("strip.html").query()).toBeNull()
    await pane.getByRole("button", { name: "Show source" }).click()
    await expect.element(pane.getByTitle("strip.html")).toBeVisible()
  })

  it("is shown as source, saying why, when it is too long to be drawn", async () => {
    await openShowcase("focus")
    buildStudioShows(htmlSamples.long)
    const pane = companionPane("Build Studio")
    await expect.element(pane.getByRole("tab", { name: "long-strip.html" })).toBeVisible()
    await expect
      .element(pane.getByText("This page is too long to draw, so its source is shown."))
      .toBeVisible()
    expect(pane.getByTitle("long-strip.html").query()).toBeNull()
  })
})
