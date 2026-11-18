import "./pdf.css"
// eslint-disable-next-line import/default -- Vite's `?url` gives the worker file's address.
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { afterEach, describe, expect, it } from "vitest"

import type { ViewerState } from "./index.js"
import { mountPdf, type PdfAssets, type PdfTrouble, type PdfViewer } from "./pdf.js"

// A PDF of its objects, numbered from 1, the first its catalog: the objects, then the table
// of where each starts. Text is taken a byte a character, as a PDF's streams are binary.
const build = (objects: readonly string[]): Blob => {
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
  return new Blob([Uint8Array.from(body, (char) => char.charCodeAt(0))], {
    type: "application/pdf",
  })
}

// One Letter page drawing `contents` with `resources`, as objects 1 to 4, and `more` after.
const onePage = (contents: string, resources: string, more: readonly string[] = []): Blob =>
  build([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources ${resources} >>`,
    `<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`,
    ...more,
  ])

// A PDF of US Letter pages (612 × 792 points), each saying its number, as a writer would
// make it.
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
  return build(objects)
}

// A 16 × 16 red JPEG 2000 image, which pdf.js decodes with its OpenJPEG wasm.
const redJpx = atob(
  "AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAEAAAABAAAwgHAAAAAAAPY29scgEAAAAAABAAAAC9anAyY/9P/1EALwAAAAAAEAAAABAAAAAAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAYCAgAA/1wAKSJ/IH7gfuB+oHbwdvB2wG8AbwBu4GdQZ1BnaFAFUAVQR1fTV9NXYv9kABAAAUxhdmM2My4xLjEwMv+QAAoAAAAAADUAAf+T3/gwGASaX9/4MBgHOIff+DAYBziHAAAAAAAAAAAAAAAAAAAAAAAA/9k=",
)

// pdf.js's own files, as the app hands them over: read from pdfjs-dist, each asked for noted.
const files = import.meta.glob<string>(
  [
    "../node_modules/pdfjs-dist/cmaps/*.bcmap",
    "../node_modules/pdfjs-dist/standard_fonts/*",
    "../node_modules/pdfjs-dist/wasm/*.wasm",
  ],
  { query: "?url&inline", import: "default" },
)
const asked: string[] = []
const assets: PdfAssets = async (kind, name) => {
  asked.push(`${kind}:${name}`)
  const folder = { cmap: "cmaps", font: "standard_fonts", wasm: "wasm" }[kind]
  const load = files[`../node_modules/pdfjs-dist/${folder}/${name}`]
  if (!load) throw new Error(`No ${name}`)
  const url = await load()
  return Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0))
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
  const viewer = mountPdf(pane, {
    content: { bytes },
    label: "report.pdf",
    worker,
    assets,
    ...options,
  })
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

// Whether a page's canvas shows red, as the JPEG 2000 image is.
const reddened = (page: HTMLElement): boolean => {
  const canvas = page.querySelector("canvas")
  if (!canvas) return false
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
  for (let index = 0; index < pixels.length; index += 4)
    if (pixels[index]! > 200 && pixels[index + 1]! < 60 && pixels[index + 2]! < 60) return true
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

describe("a PDF's drawing", () => {
  it("draws its pages afresh at a zoom that came while they were drawn", async () => {
    const pane = paneIn()
    const viewer = mount(pane, pdfOf(2))
    await opened(pane, 2)
    // At once, before the fitted drawing is in.
    viewer.zoom(1)
    const page = pagesOf(pane)[0]!
    await expect
      .poll(() => page.querySelector("canvas")?.width)
      .toBe(Math.floor(816 * devicePixelRatio))
  })

  it("draws a scanned image with the decoders the app hands it", async () => {
    const pane = paneIn()
    const image = `<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /Filter /JPXDecode /Length ${redJpx.length} >>\nstream\n${redJpx}\nendstream`
    mount(
      pane,
      onePage("q 300 0 0 300 72 400 cm /Im1 Do Q", "<< /XObject << /Im1 5 0 R >> >>", [image]),
    )
    await opened(pane, 1)
    await expect.poll(() => reddened(pagesOf(pane)[0]!)).toBe(true)
    expect(asked).toContain("wasm:openjpeg.wasm")
  })

  it("reads the CMap a font names from the app, never by an address", async () => {
    const pane = paneIn()
    const font =
      "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>"
    const descendant =
      "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 7 0 R >>"
    const descriptor =
      "<< /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 6 /FontBBox [0 -141 1000 859] /ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 700 /StemV 80 >>"
    mount(
      pane,
      onePage("BT /F1 48 Tf 72 700 Td <30423044> Tj ET", "<< /Font << /F1 5 0 R >> >>", [
        font,
        descendant,
        descriptor,
      ]),
    )
    await opened(pane, 1)
    await expect.poll(() => asked).toContain("cmap:UniJIS-UCS2-H.bcmap")
  })
})

describe("a PDF out of sight or on another screen", () => {
  it("draws no page while it has no size", async () => {
    const pane = paneIn()
    mount(pane, pdfOf(40))
    await opened(pane, 40)
    // Hidden as soon as it's laid out, while its first pages may still be drawing.
    pane.style.display = "none"
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const drawn = pagesOf(pane).filter((page) => page.querySelector("canvas")).length
    expect(drawn).toBeLessThanOrEqual(3)
  })

  it("draws its pages again for a screen of another pixel density", async () => {
    // A screen of twice the density, as the browser would report the move.
    const listeners: (() => void)[] = []
    const matchMedia = window.matchMedia
    const ratio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio")
    window.matchMedia = ((query: string) => ({
      ...matchMedia.call(window, query),
      addEventListener: (_: string, on: () => void) => listeners.push(on),
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
    try {
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 })
      const pane = paneIn()
      mount(pane, pdfOf(1))
      await opened(pane, 1)
      const page = pagesOf(pane)[0]!
      await expect.poll(() => page.querySelector("canvas")?.width ?? 0).toBeGreaterThan(350)
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 })
      listeners.forEach((on) => on())
      // Twice the pixels, in the same CSS size.
      await expect.poll(() => page.querySelector("canvas")?.width ?? 0).toBeGreaterThan(700)
    } finally {
      window.matchMedia = matchMedia
      if (ratio) Object.defineProperty(window, "devicePixelRatio", ratio)
      else Reflect.deleteProperty(window, "devicePixelRatio")
    }
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

  it("holds its place while hidden, and goes back to it shown", async () => {
    const pane = paneIn()
    const viewer = mount(pane, pdfOf(5))
    await opened(pane, 5)
    viewerOf(pane).scrollTop = pagesOf(pane)[2]!.offsetTop
    await expect.poll(() => chipOf(pane).textContent).toMatch(/^3 \/ 5/)
    pane.style.display = "none"
    await expect.poll(() => viewerOf(pane).clientHeight).toBe(0)
    expect(viewer.state()).toMatchObject({ pdf: { page: 2 } })
    pane.style.display = "flex"
    await expect.poll(() => viewerOf(pane).scrollTop).toBeCloseTo(pagesOf(pane)[2]!.offsetTop, 0)
  })

  it("goes to a saved place once it is shown, opened while hidden", async () => {
    const pane = paneIn()
    const first = mount(pane, pdfOf(5))
    await opened(pane, 5)
    viewerOf(pane).scrollTop = pagesOf(pane)[3]!.offsetTop
    await expect.poll(() => chipOf(pane).textContent).toMatch(/^4 \/ 5/)
    const state = first.state()

    const hidden = paneIn()
    hidden.style.display = "none"
    const viewer = mount(hidden, pdfOf(5), { saved: state })
    await expect.poll(() => pagesOf(hidden).length).toBe(5)
    expect(viewer.state()).toMatchObject({ pdf: { page: 3 } })
    hidden.style.display = "flex"
    await expect.poll(() => chipOf(hidden).textContent).toMatch(/^4 \/ 5/)
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
    expect(viewerOf(pane).getAttribute("aria-busy")).toBe("false")
  })

  it("says a PDF is locked with a password, which it doesn't ask for", async () => {
    const pane = paneIn()
    const troubles: (PdfTrouble | null)[] = []
    const locked = Uint8Array.from(atob(lockedPdfData), (char) => char.charCodeAt(0))
    mount(pane, new Blob([locked]), { onTrouble: (trouble) => troubles.push(trouble) })
    await expect.poll(() => troubles).toEqual(["password"])
    expect(pane.querySelector('[role="alert"]')!.textContent).toBe(
      "This PDF is locked with a password, which Novadeck doesn't open.",
    )
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

// A one-page PDF locked with a password (Ghostscript, 128-bit RC4), as base64, as the demo's
// locked.pdf is: pdf.js asks for its password.
const lockedPdfData =
  "JVBERi0xLjQKJcfsj6IKJSVJbnZvY2F0aW9uOiBncyAtcSAtZE5PUEFVU0UgLWRCQVRDSCAtc0RFVklDRT1wZGZ3cm" +
  "l0ZSAtZENvbXByZXNzUGFnZXM9dHJ1ZSAtZENvbXBhdGliaWxpdHlMZXZlbD0xLjQgLXNPd25lclBhc3N3b3JkPT8g" +
  "LXNVc2VyUGFzc3dvcmQ9PyAtZEVuY3J5cHRpb25SPTMgLWRLZXlMZW5ndGg9MTI4IC1kU3Vic2V0Rm9udHM9dHJ1ZS" +
  "AtZEVtYmVkQWxsRm9udHM9ZmFsc2UgLXNPdXRwdXRGaWxlPT8gPwo1IDAgb2JqCjw8L0xlbmd0aCA2IDAgUi9GaWx0" +
  "ZXIgL0ZsYXRlRGVjb2RlPj4Kc3RyZWFtCmmEzL1OObFw8LW1DzLXUcMXm/UDZaTg4O12Ytw9J9D0L82FCAw4IkQyH/" +
  "k2+i9aDk2VbIpXyvYzjJsYU3109VW9N6Ulzxa8T149yg5SVntlbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKNzkKZW5k" +
  "b2JqCjQgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94IFswIDAgNjEyIDc5Ml0KL1JvdGF0ZSAwL1BhcmVudCAzID" +
  "AgUgovUmVzb3VyY2VzPDwvUHJvY1NldFsvUERGIC9UZXh0XQovRm9udCA4IDAgUgo+PgovQ29udGVudHMgNSAwIFIK" +
  "Pj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFsKNCAwIFIKXSAvQ291bnQgMQo+PgplbmRvYm" +
  "oKMSAwIG9iago8PC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAzIDAgUgovTWV0YWRhdGEgOSAwIFIKPj4KZW5kb2JqCjgg" +
  "MCBvYmoKPDwvUjcKNyAwIFI+PgplbmRvYmoKNyAwIG9iago8PC9CYXNlRm9udC9IZWx2ZXRpY2EvVHlwZS9Gb250Ci" +
  "9FbmNvZGluZy9XaW5BbnNpRW5jb2RpbmcvU3VidHlwZS9UeXBlMT4+CmVuZG9iago5IDAgb2JqCjw8L1R5cGUvTWV0" +
  "YWRhdGEKL1N1YnR5cGUvWE1ML0xlbmd0aCAxMTgzPj5zdHJlYW0KPD94cGFja2V0IGJlZ2luPSfvu78nIGlkPSdXNU" +
  "0wTXBDZWhpSHpyZVN6TlRjemtjOWQnPz4KPD9hZG9iZS14YXAtZmlsdGVycyBlc2M9IkNSTEYiPz4KPHg6eG1wbWV0" +
  "YSB4bWxuczp4PSdhZG9iZTpuczptZXRhLycgeDp4bXB0az0nWE1QIHRvb2xraXQgMi45LjEtMTMsIGZyYW1ld29yay" +
  "AxLjYnPgo8cmRmOlJERiB4bWxuczpyZGY9J2h0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1u" +
  "cyMnIHhtbG5zOmlYPSdodHRwOi8vbnMuYWRvYmUuY29tL2lYLzEuMC8nPgo8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm" +
  "91dD0iIiB4bWxuczpwZGY9J2h0dHA6Ly9ucy5hZG9iZS5jb20vcGRmLzEuMy8nIHBkZjpQcm9kdWNlcj0nR1BMIEdo" +
  "b3N0c2NyaXB0IDEwLjAyLjEnLz4KPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSdodHRwOi" +
  "8vbnMuYWRvYmUuY29tL3hhcC8xLjAvJz48eG1wOk1vZGlmeURhdGU+MjAyNi0xMS0xOFQxOTozMjowMSswMTowMDwv" +
  "eG1wOk1vZGlmeURhdGU+Cjx4bXA6Q3JlYXRlRGF0ZT4yMDI2LTExLTE4VDE5OjMyOjAxKzAxOjAwPC94bXA6Q3JlYX" +
  "RlRGF0ZT4KPHhtcDpDcmVhdG9yVG9vbD5Vbmtub3duQXBwbGljYXRpb248L3htcDpDcmVhdG9yVG9vbD48L3JkZjpE" +
  "ZXNjcmlwdGlvbj4KPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eGFwTU09J2h0dHA6Ly9ucy5hZG" +
  "9iZS5jb20veGFwLzEuMC9tbS8nIHhhcE1NOkRvY3VtZW50SUQ9J3V1aWQ6ZTUxNDRjYmItMWI5YS0xMWZkLTAwMDAt" +
  "Mzg0Nzg4ZjA5NDExJy8+CjxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiIHhtbG5zOmRjPSdodHRwOi8vcHVybC" +
  "5vcmcvZGMvZWxlbWVudHMvMS4xLycgZGM6Zm9ybWF0PSdhcHBsaWNhdGlvbi9wZGYnPjxkYzp0aXRsZT48cmRmOkFs" +
  "dD48cmRmOmxpIHhtbDpsYW5nPSd4LWRlZmF1bHQnPlVudGl0bGVkPC9yZGY6bGk+PC9yZGY6QWx0PjwvZGM6dGl0bG" +
  "U+PC9yZGY6RGVzY3JpcHRpb24+CjwvcmRmOlJERj4KPC94OnhtcG1ldGE+CiAgICAgICAgICAgICAgICAgICAgICAg" +
  "ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgIC" +
  "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKPD94cGFja2V0IGVu" +
  "ZD0ndyc/PgplbmRzdHJlYW0KZW5kb2JqCjIgMCBvYmoKPDwvUHJvZHVjZXIoXDM1MVwzNzJcMDI1XDMyM35cMzQ3XD" +
  "I2NlwzNDJcMzAxXDI1MiIvXDM3NmZcMDAwXDI1NkJcMjExXDI1NVwyMjZcMjA3SF4pCi9DcmVhdGlvbkRhdGUoXDM1" +
  "MlwyMjBrXDMwM1wwMTNcMjcxXDM1MFwyNDBcMjA0XDM0MXBkXDI0NCREXDI3N1hcMjExXDI2MlwyMDFcMjA1VkgpCi" +
  "9Nb2REYXRlKFwzNTJcMjIwa1wzMDNcMDEzXDI3MVwzNTBcMjQwXDIwNFwzNDFwZFwyNDQkRFwyNzdYXDIxMVwyNjJc" +
  "MjAxXDIwNVZIKT4+ZW5kb2JqCjEwIDAgb2JqCjw8L0ZpbHRlciAvU3RhbmRhcmQgL1YgMiAvTGVuZ3RoIDEyOCAvUi" +
  "AzIC9QIC00IC9PICg+IcObRUczSfYVq8bMqquPeRfGnB66H669skGkLsDhYikKL1UgKPOSD9rEGDqt8q/gWoNTtf5c" +
  "KL9OXk51ikFkAE5W//oBCCk+PgplbmRvYmoKeHJlZgowIDExCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDYwOS" +
  "AwMDAwMCBuIAowMDAwMDAyMDUwIDAwMDAwIG4gCjAwMDAwMDA1NTAgMDAwMDAgbiAKMDAwMDAwMDQwOSAwMDAwMCBu" +
  "IAowMDAwMDAwMjQyIDAwMDAwIG4gCjAwMDAwMDAzOTEgMDAwMDAgbiAKMDAwMDAwMDcwMiAwMDAwMCBuIAowMDAwMD" +
  "AwNjczIDAwMDAwIG4gCjAwMDAwMDA3OTEgMDAwMDAgbiAKMDAwMDAwMjMxNCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9T" +
  "aXplIDExIC9Sb290IDEgMCBSIC9JbmZvIDIgMCBSCi9JRCBbPDVBMjAxMTMxQjI1REZFMzBFODlGMzRFNUJCRDJFRD" +
  "lEPjw1QTIwMTEzMUIyNURGRTMwRTg5RjM0RTVCQkQyRUQ5RD5dCi9FbmNyeXB0IDEwIDAgUiA+PgpzdGFydHhyZWYK" +
  "MjQ1NwolJUVPRgo="
