import "./pdf.css"
import { afterEach, describe, expect, it } from "vitest"

import type { ViewerState } from "./index.js"
import { mountPdf, type PdfAssets, type PdfTrouble, type PdfViewer } from "./pdf.js"
import { openPdfFrame } from "./pdf/frame-host.js"
import { pdfFrameViewer } from "./pdf/frame-viewer.js"
import frameHtml from "./pdf/frame.html?raw"
import { frameMessage } from "./pdf/messages.js"

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

// pdf.js as the app hands it to the frame: its two modules' text.
const modules = import.meta.glob<string>(
  [
    "../node_modules/pdfjs-dist/build/pdf.min.mjs",
    "../node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  ],
  { query: "?url&inline", import: "default" },
)
const textOf = async (name: string): Promise<string> => {
  const url = await modules[`../node_modules/pdfjs-dist/build/${name}`]!()
  return new TextDecoder().decode(
    Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0)),
  )
}
const code = async () => ({
  library: await textOf("pdf.min.mjs"),
  worker: await textOf("pdf.worker.min.mjs"),
})
// The frame's page, as the app serves it.
const frameUrl = URL.createObjectURL(new Blob([frameHtml], { type: "text/html" }))
const sha256 = async (text: string): Promise<string> =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    ),
  )
// The same page, but running in a frame of this page's origin, which the real one refuses: its
// script without that check, and its policy naming that script's hash.
const drawingPage = async (): Promise<string> => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(frameHtml)![1]!
  const open = script.replace('if (self.origin === "null")', "if (true)")
  return frameHtml.replace(script, open).replace(/sha256-[^']+/, `sha256-${await sha256(open)}`)
}
const drawingUrl = URL.createObjectURL(new Blob([await drawingPage()], { type: "text/html" }))

type Drawn = PdfViewer & { readonly frame: HTMLIFrameElement }
const panes: HTMLElement[] = []
const viewers: { destroy: () => void }[] = []
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

// The viewer as its frame runs it, through the frame's own page, but in a frame of this
// page's origin, so a test can look at what it drew; `mountPdf` sandboxes it (see the tests of
// its walls below). Its place, trouble and files go as `mountPdf` passes them.
const mount = (
  pane: HTMLElement,
  bytes: Blob,
  options: {
    saved?: ViewerState
    onTrouble?: (trouble: PdfTrouble | null) => void
    viewer?: string
  } = {},
): Drawn => {
  const iframe = document.createElement("iframe")
  iframe.style.cssText = "flex: 1; min-height: 0; border: 0"
  pane.append(iframe)
  type Place = { page: number; within: number; zoom: "fit" | number }
  let place = (options.saved as unknown as { pdf?: Place } | undefined)?.pdf
  let ready = false
  const queue: [Record<string, unknown>, Transferable[]][] = []
  const send = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    if (ready) frame.post(message, transfer)
    else queue.push([message, transfer])
  }
  const frame = openPdfFrame({
    iframe,
    url: drawingUrl,
    code,
    viewer: options.viewer ?? pdfFrameViewer.toString(),
    hear: (data) => {
      const message = frameMessage(data)
      if (!message) return
      if (message.type === "ready") {
        ready = true
        for (const [queued, transfer] of queue.splice(0)) frame.post(queued, transfer)
      }
      if (message.type === "place")
        place = { page: message.page, within: message.within, zoom: message.zoom }
      if (message.type === "trouble") options.onTrouble?.(message.trouble)
      if (message.type === "asset")
        void assets(message.kind, message.name).then(
          (found) => {
            const copy = found.slice().buffer
            frame.post({ type: "asset", id: message.id, bytes: copy }, [copy])
          },
          () => frame.post({ type: "asset", id: message.id }),
        )
    },
    stopped: () => {},
  })
  const open = (blob: Blob) =>
    void blob.arrayBuffer().then((data) => send({ type: "open", bytes: data }, [data]))
  if (place) send({ type: "place", place })
  open(bytes)
  const viewer: Drawn = {
    frame: iframe,
    update: (next) => open(next.bytes),
    state: () => ({ pdf: place ?? { page: 0, within: 0, zoom: "fit" } }) as unknown as ViewerState,
    restore: (state) => {
      place = (state as unknown as { pdf: Place }).pdf
      send({ type: "place", place })
    },
    jumpTo: () => {},
    focus: () => {},
    zoom: (zoom) => send({ type: "zoom", zoom }),
    destroy: () => {
      frame.close()
      iframe.remove()
    },
  }
  viewers.push(viewer)
  return viewer
}

const docOf = (pane: HTMLElement): Document | undefined =>
  pane.querySelector("iframe")?.contentDocument ?? undefined
const viewerOf = (pane: HTMLElement): HTMLElement => docOf(pane)!.querySelector(".pdf-viewer")!
const pagesOf = (pane: HTMLElement): HTMLElement[] =>
  [...(docOf(pane)?.querySelectorAll(".pdf-page") ?? [])] as HTMLElement[]
const chipOf = (pane: HTMLElement): HTMLButtonElement => docOf(pane)!.querySelector(".pdf-chip")!
const opened = async (pane: HTMLElement, count: number): Promise<void> => {
  await expect.poll(() => pagesOf(pane).length).toBe(count)
  await expect
    .poll(() => docOf(pane)?.querySelector(".pdf-viewer")?.getAttribute("aria-busy"))
    .toBe("false")
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
    // The frame's screen, which the test moves: its density, and who listens for a change.
    const wrapped = `function (env) {
      let ratio = 1
      const listeners = []
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => ratio })
      const media = window.matchMedia.bind(window)
      window.matchMedia = (query) => {
        const real = media(query)
        return {
          matches: real.matches, media: real.media,
          addEventListener: (_, on) => listeners.push(on),
          removeEventListener: () => {},
        }
      }
      window.moveScreen = (to) => { ratio = to; listeners.splice(0).forEach((on) => on()) }
      return (${pdfFrameViewer.toString()})(env)
    }`
    const pane = paneIn()
    mount(pane, pdfOf(1), { viewer: wrapped })
    await opened(pane, 1)
    const page = pagesOf(pane)[0]!
    await expect.poll(() => page.querySelector("canvas")?.width ?? 0).toBeGreaterThan(350)
    const frameWindow = pane.querySelector("iframe")!.contentWindow as Window & {
      moveScreen: (ratio: number) => void
    }
    frameWindow.moveScreen(2)
    // Twice the pixels, in the same CSS size.
    await expect.poll(() => page.querySelector("canvas")?.width ?? 0).toBeGreaterThan(700)
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
    await expect.poll(() => viewer.state()).toMatchObject({ pdf: { page: 2 } })
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
    await expect.poll(() => viewer.state()).toMatchObject({ pdf: { page: 3 } })
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
    expect(docOf(pane)!.querySelector('[role="alert"]')!.textContent).toBe(
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
    expect(docOf(pane)!.querySelector('[role="alert"]')!.textContent).toBe(
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
    expect(docOf(pane)!.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(true)
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

// The viewer as the app mounts it: in a sandboxed frame of no origin.
const mountIsolated = (
  pane: HTMLElement,
  bytes: Blob,
  options: {
    viewer?: string
    onTrouble?: (trouble: PdfTrouble | null) => void
    onAction?: (action: string) => void
    assets?: PdfAssets
  } = {},
): PdfViewer => {
  const viewer = mountPdf(pane, {
    content: { bytes },
    label: "report.pdf",
    frame: { url: frameUrl, code, ...(options.viewer && { viewer: options.viewer }) },
    assets: options.assets ?? assets,
    ...(options.onTrouble && { onTrouble: options.onTrouble }),
    ...(options.onAction && { onAction: options.onAction }),
  })
  viewers.push(viewer)
  return viewer
}

describe("a PDF in its frame", () => {
  it("is drawn in a sandboxed frame of no origin, which the app can't look into", async () => {
    const pane = paneIn()
    mountIsolated(pane, pdfOf(3))
    const frame = pane.querySelector("iframe")!
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    expect(frame.title).toBe("report.pdf")
    // Opened and laid out in the frame, which says only that.
    await expect
      .poll(() => pane.querySelector(".pdf-host")!.getAttribute("aria-busy"))
      .toBe("false")
    expect(frame.contentDocument).toBeNull()
  })

  it("hears why a PDF isn't drawn, from the frame", async () => {
    const pane = paneIn()
    const troubles: (PdfTrouble | null)[] = []
    mountIsolated(pane, new Blob(["not a PDF"]), { onTrouble: (found) => troubles.push(found) })
    await expect.poll(() => troubles).toEqual(["unreadable"])
  })
})

// What a script in the frame tries, as if a PDF had made pdf.js run it: the app's page, its
// storage, the network (the runner's socket among it), popups and the window's address. It says
// what happened over its port, and which of the page's rules stopped it.
const attack = `function attack({ port }) {
  const results = {}
  const violations = []
  document.addEventListener("securitypolicyviolation", (event) =>
    violations.push(event.effectiveDirective),
  )
  const attempt = async (name, run) => {
    try {
      await run()
      results[name] = "allowed"
    } catch (error) {
      results[name] = error && error.name === "SecurityError" ? "refused" : "failed"
    }
  }
  port.onmessage = async ({ data }) => {
    if (!data || data.type !== "targets") return
    await attempt("parentDocument", () => parent.document.body.dataset.reached = "yes")
    await attempt("topDocument", () => top.document.title)
    await attempt("storage", () => localStorage.setItem("reached", "yes"))
    await attempt("database", () => indexedDB.open("reached"))
    await attempt("cookie", () => { document.cookie = "reached=yes"; if (!document.cookie) throw new Error("none") })
    await attempt("fetch", () => fetch(data.page, { mode: "no-cors" }))
    await attempt("socket", () => new Promise((open, fail) => {
      const socket = new WebSocket(data.socket)
      socket.onopen = open
      socket.onerror = () => fail(new Error("closed"))
    }))
    await attempt("popup", () => { if (!window.open(data.page)) throw new Error("none") })
    await attempt("topNavigation", () => { top.location.href = data.page })
    const rtc = { here: typeof self.RTCPeerConnection }
    const child = document.createElement("iframe")
    document.body.append(child)
    await new Promise((settled) => setTimeout(settled, 100))
    try {
      rtc.child = typeof child.contentWindow.RTCPeerConnection
    } catch (error) {
      rtc.child = error && error.name
    }
    // A child given a script of its own: inline, or from a blob the frame made.
    const said = []
    addEventListener("message", (event) => said.push(String(event.data)))
    const script = URL.createObjectURL(
      new Blob(["parent.postMessage('blob ' + typeof RTCPeerConnection, '*')"], { type: "text/javascript" }),
    )
    const scripted = document.createElement("iframe")
    scripted.srcdoc =
      "<script>parent.postMessage('inline ' + typeof RTCPeerConnection, '*')</" +
      "script><script src='" + script + "'></" + "script>"
    document.body.append(scripted)
    await new Promise((settled) => setTimeout(settled, 500))
    rtc.scripted = said.join(",") || "nothing ran"
    await new Promise((settled) => setTimeout(settled, 200))
    port.postMessage({ type: "report", results, violations, rtc })
  }
  port.postMessage({ type: "ready" })
}`

describe("the frame's walls", () => {
  it("keep a script in it from the app's page, its storage, the network and the window", async () => {
    const pane = paneIn()
    const iframe = document.createElement("iframe")
    iframe.setAttribute("sandbox", "allow-scripts")
    pane.append(iframe)
    let report:
      | { results: Record<string, string>; violations: string[]; rtc: Record<string, string> }
      | undefined
    const frame = openPdfFrame({
      iframe,
      url: frameUrl,
      code,
      viewer: attack,
      hear: (data) => {
        const message = data as { type?: string }
        if (message?.type === "ready")
          frame.post({
            type: "targets",
            page: location.href,
            socket: `ws://${location.host}/`,
          })
        if (message?.type === "report") report = data as typeof report
      },
      stopped: () => {},
    })
    viewers.push({ destroy: frame.close })
    await expect.poll(() => report, { timeout: 15_000 }).toBeDefined()
    expect(report!.results).toEqual({
      parentDocument: "refused",
      topDocument: "refused",
      storage: "refused",
      database: "refused",
      cookie: "refused",
      fetch: "failed",
      socket: "failed",
      popup: "failed",
      topNavigation: "refused",
    })
    // The fetch and the socket were refused by the page's own rules, not by chance.
    expect(report!.violations.filter((each) => each === "connect-src")).toHaveLength(2)
    // WebRTC, which no page policy covers, is gone from the frame, and a child frame of it, of
    // an origin of its own and under its policy, neither hands it back nor runs a script.
    expect(report!.rtc).toEqual({
      here: "undefined",
      child: "SecurityError",
      scripted: "nothing ran",
    })
    expect(document.body.dataset.reached).toBeUndefined()
    expect(localStorage.getItem("reached")).toBeNull()
  })

  it("let through none of a frame's messages but the viewer's own, nor a key, nor a type", async () => {
    // A frame that says it's ready, then sends what the app must not act on: keys, typing,
    // actions while it hasn't the focus, a place out of range, and a message to the app's page.
    const forge = `function forge({ port }) {
      port.postMessage({ type: "ready" })
      port.postMessage({ type: "key", key: "a", code: "KeyA" })
      port.postMessage({ type: "action", action: "type", text: "rm -rf ~\\n" })
      port.postMessage({ type: "action", action: "hide", text: "extra" })
      port.postMessage({ type: "place", page: -1, within: 2, zoom: 99, scale: 1, pages: 1 })
      for (let index = 0; index < 20; index++) port.postMessage({ type: "action", action: "hide" })
      parent.postMessage({ type: "novadeck:page-request", url: "https://example.com/" }, "*")
      // Everything above has been sent.
      port.postMessage({ type: "busy", busy: false })
      port.onmessage = ({ data }) => {
        if (data && data.type === "zoom")
          for (let index = 0; index < 20; index++)
            port.postMessage({ type: "action", action: "next-tab" })
      }
    }`
    const pane = paneIn()
    const actions: string[] = []
    const posted: MessageEvent[] = []
    const listen = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type === "novadeck:page-request")
        posted.push(event)
    }
    window.addEventListener("message", listen)
    try {
      const viewer = mountIsolated(pane, pdfOf(1), {
        viewer: forge,
        onAction: (action) => actions.push(action),
      })
      const iframe = pane.querySelector("iframe")!
      await expect.poll(() => posted.length).toBe(1)
      await expect
        .poll(() => pane.querySelector(".pdf-host")!.getAttribute("aria-busy"))
        .toBe("false")
      // What it posted the app's page names its frame as the sender, which the app's own
      // listeners check against their own.
      expect(posted[0]!.source).toBe(iframe.contentWindow)
      // Not focused: no action, and nothing else it sent was taken.
      expect(actions).toEqual([])
      expect(viewer.state()).toEqual({ pdf: { page: 0, within: 0, zoom: "fit" } })
      // Given the focus, a burst is cut to a few a second.
      viewer.focus()
      viewer.zoom(1)
      await expect.poll(() => actions.length).toBe(5)
      await new Promise((settled) => setTimeout(settled, 300))
      expect(actions).toEqual(Array(5).fill("next-tab"))
    } finally {
      window.removeEventListener("message", listen)
    }
  })

  it("let go of a frame that loads another page than its own", async () => {
    const leave = `function leave() { location.href = "data:text/html,<p>elsewhere</p>" }`
    const pane = paneIn()
    const troubles: (PdfTrouble | null)[] = []
    mountIsolated(pane, pdfOf(1), { viewer: leave, onTrouble: (found) => troubles.push(found) })
    await expect.poll(() => troubles).toEqual(["unreadable"])
    expect(pane.querySelector("iframe")).toBeNull()
    expect(pane.querySelector('[role="alert"]')!.textContent).toBe("The PDF viewer stopped.")
  })
})

describe("the frame's hold on the focus", () => {
  // A frame that waits, then takes the focus itself, as a script in it could.
  const steal = `function steal({ port }) {
    port.postMessage({ type: "ready" })
    setTimeout(() => {
      window.focus()
      document.body.tabIndex = 0
      document.body.focus()
    }, 300)
  }`

  it("goes back to where it was when a script in the frame takes it", async () => {
    const pane = paneIn()
    const field = document.createElement("input")
    document.body.append(field)
    try {
      field.focus()
      mountIsolated(pane, pdfOf(1), { viewer: steal })
      await new Promise((settled) => setTimeout(settled, 1200))
      expect(document.activeElement).toBe(field)
    } finally {
      field.remove()
    }
  })

  it("is the frame's when the person presses on it, or Tabs to it", async () => {
    const pane = paneIn()
    mountIsolated(pane, pdfOf(1))
    const glass = pane.querySelector<HTMLElement>(".pdf-glass")!
    const frame = pane.querySelector("iframe")!
    expect(frame.tabIndex).toBe(-1)
    glass.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(frame)
    expect(glass.hidden).toBe(true)
    frame.blur()
    expect(glass.hidden).toBe(false)
    glass.focus()
    expect(document.activeElement).toBe(frame)
  })
})

describe("the files a frame asks for", () => {
  it("are read once each, and only a few a second", async () => {
    const flood = `function flood({ port }) {
      port.postMessage({ type: "ready" })
      for (let id = 1; id <= 100; id++)
        port.postMessage({ type: "asset", id, kind: "cmap", name: "Name" + (id % 40) + ".bcmap" })
    }`
    const read: string[] = []
    const counting: PdfAssets = async (_, name) => {
      read.push(name)
      return new Uint8Array(4)
    }
    const pane = paneIn()
    mountIsolated(pane, pdfOf(1), { viewer: flood, assets: counting })
    await expect.poll(() => read.length).toBe(16)
    await new Promise((settled) => setTimeout(settled, 300))
    expect(read).toHaveLength(16)
  })
})

describe("the frame's page", () => {
  it("runs nothing in a frame that isn't sandboxed, which would have the app's origin", async () => {
    const pane = paneIn()
    const iframe = document.createElement("iframe")
    pane.append(iframe)
    const heard: unknown[] = []
    const frame = openPdfFrame({
      iframe,
      url: frameUrl,
      code,
      viewer: "function ran({ port }) { port.postMessage({ type: 'ready' }) }",
      hear: (data) => heard.push(data),
      stopped: () => {},
    })
    viewers.push({ destroy: frame.close })
    await new Promise((settled) => setTimeout(settled, 1500))
    expect(heard).toEqual([])
  })

  it("allows its one script by its hash, and no network", async () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(frameHtml)![1]!
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script))
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)))
    const policy = /Content-Security-Policy"\s+content="([^"]*)"/.exec(frameHtml)![1]!
    expect(policy).toContain(`script-src 'sha256-${hash}' blob: 'wasm-unsafe-eval';`)
    expect(policy.startsWith("default-src 'none';")).toBe(true)
    // No network, no eval but WebAssembly's, and no inline script but its own.
    expect(policy).not.toMatch(/connect-src|[^-]unsafe-eval|https?:/)
    expect(/script-src[^;]*/.exec(policy)![0]).not.toContain("unsafe-inline")
  })
})
