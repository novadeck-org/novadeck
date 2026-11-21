import "./html.css"
import { afterEach, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import frameHtml from "./frame/frame.html?raw"
import { mountHtml, type HtmlContent, type HtmlFrame, type HtmlViewer } from "./html.js"
// eslint-disable-next-line import/default -- The bundle's text, as the frame plugin gives it.
import htmlCode from "./html/frame-entry.ts?frame"

// The frame's page, as the app serves it, and the viewer's code as the app bundles it.
const frame: HtmlFrame = {
  url: URL.createObjectURL(new Blob([frameHtml], { type: "text/html" })),
  code: async () => ({ scripts: [htmlCode] }),
}

const encode = (text: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>

// A PNG of one colour, as a file beside a page.
const solid = async (color: string): Promise<Uint8Array<ArrayBuffer>> => {
  const canvas = new OffscreenCanvas(8, 8)
  const context = canvas.getContext("2d")!
  context.fillStyle = color
  context.fillRect(0, 0, 8, 8)
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer())
}

const panes: HTMLElement[] = []
const viewers: HtmlViewer[] = []
afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy()
  for (const pane of panes.splice(0)) pane.remove()
})

const mount = (content: HtmlContent): { pane: HTMLElement; viewer: HtmlViewer } => {
  const pane = document.createElement("div")
  pane.style.cssText = "display: flex; flex-direction: column; height: 300px; width: 300px"
  document.body.append(pane)
  panes.push(pane)
  const viewer = mountHtml(pane, { content, label: "strip.html", frame })
  viewers.push(viewer)
  return { pane, viewer }
}

// Waits for the frame to have drawn what it was given.
const loaded = async (pane: HTMLElement): Promise<void> => {
  await expect.poll(() => pane.querySelector(".html-host")!.getAttribute("aria-busy")).toBe("false")
}

// The colour at (x, y) of what the pane shows: a screenshot of it, which reads what the frame
// drew, as the app's page can't look into it.
const colorAt = async (pane: HTMLElement, x: number, y: number): Promise<string> => {
  const base64 = await page.screenshot({ element: pane, save: false })
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
  const canvas = new OffscreenCanvas(image.width, image.height)
  const context = canvas.getContext("2d")!
  context.drawImage(image, 0, 0)
  const [r, g, b] = context.getImageData(x, y, 1, 1).data
  return `${r},${g},${b}`
}

const page1 = `<!doctype html>
<link rel="stylesheet" href="strip.css">
<body style="margin: 0">
<div class="green"></div>
<img class="picture" src="img/red.png" alt="">
<div class="back"></div>
<script>document.body.style.background = "black"</script>`

const css = `
  @import "base.css";
  .green { height: 100px; background: #00a000 }
  .picture { display: block; width: 300px; height: 100px }
  .back { height: 100px; background: url(img/blue.png) }
`

describe("a web page in its frame", () => {
  it("is drawn in a sandboxed frame of no origin, which the app can't look into", async () => {
    const { pane } = mount({ html: "<p>hi</p>", files: [] })
    const iframe = pane.querySelector("iframe")!
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.title).toBe("strip.html")
    await loaded(pane)
    expect(iframe.contentDocument).toBeNull()
    // The page takes the pointer as it is: nothing in front of it.
    expect(pane.querySelector(".html-glass")).toBeNull()
  })

  it("draws the page with its stylesheet, its imports and its pictures", async () => {
    const { pane } = mount({
      html: page1,
      files: [
        { name: "strip.css", bytes: encode(css) },
        { name: "base.css", bytes: encode("body { margin: 0 }") },
        { name: "img/red.png", bytes: await solid("#e00000") },
        { name: "img/blue.png", bytes: await solid("#0000e0") },
      ],
    })
    await loaded(pane)
    await expect.poll(() => colorAt(pane, 150, 50)).toBe("0,160,0")
    expect(await colorAt(pane, 150, 150)).toBe("224,0,0")
    expect(await colorAt(pane, 150, 250)).toBe("0,0,224")
  })

  it("draws a page again once it is written again, the old one in view meanwhile", async () => {
    const files = [
      { name: "strip.css", bytes: encode(".green { height: 300px; background: #00a000 }") },
    ]
    const { pane, viewer } = mount({
      html: '<link rel="stylesheet" href="strip.css"><body style="margin:0"><div class="green"></div>',
      files,
    })
    await loaded(pane)
    await expect.poll(() => colorAt(pane, 150, 150)).toBe("0,160,0")
    viewer.update({
      html: '<link rel="stylesheet" href="strip.css"><body style="margin:0"><div class="green"></div>',
      files: [
        { name: "strip.css", bytes: encode(".green { height: 300px; background: #a000a0 }") },
      ],
    })
    await expect.poll(() => colorAt(pane, 150, 150)).toBe("160,0,160")
    await loaded(pane)
  })

  it("says it stopped when the frame loads another page than its own", async () => {
    const { pane } = mount({ html: "<p>hi</p>", files: [] })
    await loaded(pane)
    pane.querySelector("iframe")!.src = "about:blank"
    await expect
      .poll(() => pane.querySelector(".html-host-notice")?.textContent)
      .toBe("The page viewer stopped.")
  })
})
