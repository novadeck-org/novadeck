import "./pdf.css"
// eslint-disable-next-line import/default -- Vite's `?url` gives the worker file's address.
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { afterEach, describe, expect, it } from "vitest"

import type { ViewerState } from "./index.js"
import { mountPdf, type PdfTrouble, type PdfViewer } from "./pdf.js"

// A PDF of US Letter pages (612 × 792 points), each saying its number, as a writer would
// make it: objects, then the table of where each starts.
const pdfOf = (count: number, label = "Page"): Blob => {
  const objects: string[] = []
  const pages = Array.from({ length: count }, (_, index) => 4 + index * 2)
  objects.push("<< /Type /Catalog /Pages 2 0 R >>")
  objects.push(
    `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] /Count ${count} >>`,
  )
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  for (const [index, id] of pages.entries()) {
    const text = `BT /F1 48 Tf 72 700 Td (${label} ${index + 1}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${id + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    )
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  }
  let body = "%PDF-1.4\n"
  const offsets = objects.map((object, index) => {
    const offset = body.length
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const table = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`
  return new Blob([body], { type: "application/pdf" })
}

const panes: HTMLElement[] = []
const viewers: PdfViewer[] = []
afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy()
  for (const pane of panes.splice(0)) pane.remove()
})

const paneIn = (width = 400): HTMLElement => {
  const pane = document.createElement("div")
  pane.style.cssText = `display: flex; flex-direction: column; height: 300px; width: ${width}px`
  document.body.append(pane)
  panes.push(pane)
  return pane
}

const mount = (
  pane: HTMLElement,
  bytes: Blob,
  options: { saved?: ViewerState; onTrouble?: (trouble: PdfTrouble | null) => void } = {},
): PdfViewer => {
  const viewer = mountPdf(pane, { content: { bytes }, label: "report.pdf", worker, ...options })
  viewers.push(viewer)
  return viewer
}

const viewerOf = (pane: HTMLElement): HTMLElement => pane.querySelector(".pdf-viewer")!
const pagesOf = (pane: HTMLElement): HTMLElement[] =>
  [...pane.querySelectorAll(".pdf-page")] as HTMLElement[]
const chipOf = (pane: HTMLElement): HTMLButtonElement => pane.querySelector(".pdf-chip")!
const opened = async (pane: HTMLElement, count: number): Promise<void> => {
  await expect.poll(() => pagesOf(pane).length).toBe(count)
  await expect.poll(() => viewerOf(pane).getAttribute("aria-busy")).toBe("false")
}

// Whether a page's canvas has anything dark on it: its text, drawn.
const inked = (page: HTMLElement): boolean => {
  const canvas = page.querySelector("canvas")
  if (!canvas) return false
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
  for (let index = 0; index < pixels.length; index += 4)
    if (pixels[index]! < 128 && pixels[index + 3]! > 0) return true
  return false
}

const key = (pane: HTMLElement, name: string): void => {
  viewerOf(pane).focus()
  viewerOf(pane).dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
  )
}

describe("a PDF in its viewer", () => {
  it("lays out every page fitted to the viewer's width and draws those in view", async () => {
    const pane = paneIn()
    mount(pane, pdfOf(5))
    await opened(pane, 5)
    const [first, , , , last] = pagesOf(pane)
    // 400 wide less 20 each side: a Letter page of 816 CSS pixels at 100%.
    expect(first!.getBoundingClientRect().width).toBeCloseTo(360, 0)
    expect(first!.getBoundingClientRect().height).toBeCloseTo(360 * (792 / 612), 0)
    await expect.poll(() => inked(first!)).toBe(true)
    // Far below the view, the last page waits to be drawn.
    expect(last!.querySelector("canvas")).toBeNull()
    expect(chipOf(pane).textContent).toBe("1 / 5 · 44%")
    expect(viewerOf(pane).getAttribute("aria-label")).toBe("report.pdf")
  })

  it("draws a page as it's scrolled to, and names it on the chip", async () => {
    const pane = paneIn()
    mount(pane, pdfOf(5))
    await opened(pane, 5)
    const last = pagesOf(pane)[4]!
    viewerOf(pane).scrollTop = last.offsetTop
    await expect.poll(() => inked(last)).toBe(true)
    await expect.poll(() => chipOf(pane).textContent).toBe("5 / 5 · 44%")
  })

  it("never draws a page past its actual size to fit a wide viewer", async () => {
    const pane = paneIn(1400)
    mount(pane, pdfOf(1))
    await opened(pane, 1)
    expect(pagesOf(pane)[0]!.getBoundingClientRect().width).toBeCloseTo(816, 0)
    expect(chipOf(pane).textContent).toBe("1 / 1 · 100%")
  })

  it("zooms with its keys and the wheel with Ctrl, and fits again from its chip", async () => {
    const pane = paneIn()
    mount(pane, pdfOf(2))
    await opened(pane, 2)
    key(pane, "+")
    expect(chipOf(pane).textContent).toBe("1 / 2 · 55%")
    expect(pagesOf(pane)[0]!.getBoundingClientRect().width).toBeCloseTo(816 * 0.55, -1)
    // Wider than the viewer, it scrolls across.
    key(pane, "+")
    key(pane, "+")
    expect(viewerOf(pane).scrollWidth).toBeGreaterThan(viewerOf(pane).clientWidth)
    key(pane, "0")
    expect(chipOf(pane).textContent).toBe("1 / 2 · 44%")
    const event = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true })
    viewerOf(pane).dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(chipOf(pane).textContent).toBe("1 / 2 · 51%")
    chipOf(pane).click()
    expect(chipOf(pane).textContent).toBe("1 / 2 · 44%")
  })

  it("leaves a plain wheel to scroll it", async () => {
    const pane = paneIn()
    mount(pane, pdfOf(2))
    await opened(pane, 2)
    const event = new WheelEvent("wheel", { deltaY: 100, cancelable: true })
    viewerOf(pane).dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe("a PDF's place", () => {
  it("opens where an earlier viewer of it was, page, place in it and zoom", async () => {
    const pane = paneIn()
    const first = mount(pane, pdfOf(5))
    await opened(pane, 5)
    key(pane, "+")
    const page = pagesOf(pane)[3]!
    viewerOf(pane).scrollTop = page.offsetTop + page.offsetHeight / 2
    await expect.poll(() => chipOf(pane).textContent).toBe("4 / 5 · 55%")
    const state = first.state()
    first.destroy()

    const next = paneIn(600)
    mount(next, pdfOf(5), { saved: state })
    await opened(next, 5)
    const again = pagesOf(next)[3]!
    expect(chipOf(next).textContent).toBe("4 / 5 · 55%")
    expect(viewerOf(next).scrollTop).toBeCloseTo(again.offsetTop + again.offsetHeight / 2, 0)
  })

  it("keeps its place, fitted, as the viewer narrows", async () => {
    const pane = paneIn(600)
    mount(pane, pdfOf(5))
    await opened(pane, 5)
    viewerOf(pane).scrollTop = pagesOf(pane)[2]!.offsetTop
    await expect.poll(() => chipOf(pane).textContent).toMatch(/^3 \/ 5/)
    pane.style.width = "300px"
    await expect.poll(() => chipOf(pane).textContent).toBe("3 / 5 · 32%")
    expect(viewerOf(pane).scrollTop).toBeCloseTo(pagesOf(pane)[2]!.offsetTop, 0)
  })

  it("keeps its place when the PDF is written again", async () => {
    const pane = paneIn()
    const viewer = mount(pane, pdfOf(5))
    await opened(pane, 5)
    viewerOf(pane).scrollTop = pagesOf(pane)[3]!.offsetTop
    await expect.poll(() => chipOf(pane).textContent).toMatch(/^4 \/ 5/)
    viewer.update({ bytes: pdfOf(6, "Revised") })
    await opened(pane, 6)
    expect(chipOf(pane).textContent).toBe("4 / 6 · 44%")
  })

  it("takes a state given before its PDF has opened", async () => {
    const pane = paneIn()
    const first = mount(pane, pdfOf(5))
    await opened(pane, 5)
    viewerOf(pane).scrollTop = pagesOf(pane)[4]!.offsetTop
    await expect.poll(() => chipOf(pane).textContent).toMatch(/^5 \/ 5/)
    const state = first.state()

    const next = paneIn()
    const viewer = mount(next, pdfOf(5))
    viewer.restore(state)
    // Asked before it opened, it keeps that place.
    expect(viewer.state()).toEqual(state)
    await opened(next, 5)
    expect(chipOf(next).textContent).toMatch(/^5 \/ 5/)
  })
})

describe("a PDF it can't draw", () => {
  it("says a file isn't a PDF it can read", async () => {
    const pane = paneIn()
    const troubles: (PdfTrouble | null)[] = []
    mount(pane, new Blob(["not a PDF at all"]), { onTrouble: (trouble) => troubles.push(trouble) })
    await expect.poll(() => troubles).toEqual(["unreadable"])
    expect(pane.querySelector('[role="alert"]')!.textContent).toBe(
      "This file couldn't be read as a PDF.",
    )
    expect(pagesOf(pane)).toEqual([])
    expect(chipOf(pane).hidden).toBe(true)
  })

  it("draws it once it's written again as a PDF", async () => {
    const pane = paneIn()
    const troubles: (PdfTrouble | null)[] = []
    const viewer = mount(pane, new Blob(["half written"]), {
      onTrouble: (trouble) => troubles.push(trouble),
    })
    await expect.poll(() => troubles).toEqual(["unreadable"])
    viewer.update({ bytes: pdfOf(2) })
    await opened(pane, 2)
    expect(troubles).toEqual(["unreadable", null])
    expect(pane.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(true)
  })
})
