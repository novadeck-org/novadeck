// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm"
import { afterEach, describe, expect, it, vi } from "vitest"

// jsdom has no canvas or media queries; xterm opens without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})

// jsdom lays nothing out, so the elements xterm measures read as a width of the test's making:
// `glyph` px a character, 10 for a family named JB once it has "loaded", 8 otherwise. The
// reads of the elements that measure single glyphs are counted. xterm's own character-size
// element reads the same, so a screen's size goes from 0 to a real one as it opens, as in a
// browser. `broken` makes the glyph elements read 0, as an element with no layout does.
let reads = 0
let broken = false
let jbLoaded = false
let glyph = 8
const familyOf = (el: HTMLElement): string =>
  el.style.fontFamily || el.parentElement?.style.fontFamily || ""
const perGlyph = (el: HTMLElement): number => (familyOf(el).includes("JB") && jbLoaded ? 10 : glyph)
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.closest(".xterm-width-cache-measure-container")) {
      reads += 1
      return broken ? 0 : (this.textContent?.length ?? 0) * perGlyph(this)
    }
    return this.classList.contains("xterm-char-measure-element")
      ? (this.textContent?.length ?? 0) * perGlyph(this)
      : 0
  },
})
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains("xterm-char-measure-element") ? 16 : 0
  },
})

const hosts: HTMLElement[] = []
const terminals: Terminal[] = []
type Renderer = {
  handleCharSizeChanged(): void
  _rowContainer: HTMLElement
  _widthCache: {
    get(chars: string, bold: boolean, italic: boolean): number
    _shared: { holey: Map<string, number> }
  }
}
type Core = {
  _core: {
    _renderService: {
      _renderRows(first: number, last: number): void
      _renderer: { value: Renderer }
    }
  }
}
// xterm keeps its renderer private; the test reaches it by name, as the app never does.
const renderService = (terminal: Terminal) =>
  (terminal as unknown as Core)["_core"]["_renderService"]
const renderer = (terminal: Terminal): Renderer => renderService(terminal)["_renderer"].value

// A screen opened in the page with some text on it, drawn at once; the reads it took, and the
// screen, come back.
const open = async (options: ConstructorParameters<typeof Terminal>[0] = {}) => {
  const before = reads
  const host = document.body.appendChild(document.createElement("div"))
  const terminal = new Terminal({ fontFamily: "Test Mono", fontSize: 14, ...options })
  hosts.push(host)
  terminals.push(terminal)
  terminal.open(host)
  await new Promise<void>((done) =>
    terminal.write("Hello, wörld! \u001b[1mbold\u001b[0m \u001b[3mitalic\u001b[0m", done),
  )
  renderService(terminal)["_renderRows"](0, terminal.rows - 1)
  return { terminal, reads: reads - before }
}

afterEach(() => {
  terminals.splice(0).forEach((terminal) => terminal.dispose())
  hosts.splice(0).forEach((host) => host.remove())
  broken = false
  jbLoaded = false
  glyph = 8
  // The page's shared measurements, so each test starts with none.
  Reflect.deleteProperty(document, Symbol.for("novadeck.xterm.widths"))
})

describe("the DOM renderer's width measurements", () => {
  it("are shared: a screen opened after another has drawn measures next to nothing", async () => {
    const first = await open()
    expect(first.reads).toBeGreaterThan(5)
    // Opening sets the screen's size from 0 to a real one, which xterm answers with a clear.
    // One read checks the font behind the entry is the same; no glyph is measured again.
    expect((await open()).reads).toBeLessThanOrEqual(1)
    expect((await open()).reads).toBeLessThanOrEqual(1)
  })

  it("are kept apart by font family, size, weight and bold weight", async () => {
    await open()
    const measured = async (options: Parameters<typeof open>[0]) => (await open(options)).reads
    expect(await measured({ fontFamily: "Other Mono" })).toBeGreaterThan(5)
    expect(await measured({ fontSize: 15 })).toBeGreaterThan(5)
    expect(await measured({ fontWeight: "300" })).toBeGreaterThan(5)
    expect(await measured({ fontWeightBold: "800" })).toBeGreaterThan(5)
  })

  it("are kept apart by device pixel ratio", async () => {
    await open()
    const original = window.devicePixelRatio
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 })
    try {
      expect((await open()).reads).toBeGreaterThan(5)
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: original })
    }
  })

  it("are measured again once the font's metrics change under a screen", async () => {
    const first = await open()
    glyph = 9
    renderer(first.terminal).handleCharSizeChanged()
    expect((await open()).reads).toBeGreaterThan(5)
  })

  it("are dropped for every font when a web font finishes loading", async () => {
    const fonts = new EventTarget()
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts })
    try {
      await open()
      await open({ fontFamily: "Other Mono" })
      // Screens still open would measure again at once; these are gone, as the page's may be.
      terminals.splice(0).forEach((terminal) => terminal.dispose())
      fonts.dispatchEvent(new Event("loadingdone"))
      expect((await open()).reads).toBeGreaterThan(5)
      expect((await open({ fontFamily: "Other Mono" })).reads).toBeGreaterThan(5)
    } finally {
      Reflect.deleteProperty(document, "fonts")
    }
  })

  it("come out right when a font loads after a screen measured with its fallback", async () => {
    const { terminal } = await open({ fontFamily: "JB, monospace" })
    expect(renderer(terminal)["_widthCache"].get("i", false, false)).toBe(8)
    jbLoaded = true
    // What view.ts does once the font has loaded: another family first, then the family again.
    terminal.options.fontFamily = "monospace"
    terminal.options.fontFamily = "JB, monospace"
    expect(renderer(terminal)["_widthCache"].get("i", false, false)).toBe(10)
    // The cell is 10 wide and so is a glyph: no letter-spacing to make up for the fallback.
    expect(parseFloat(renderer(terminal)["_rowContainer"].style.letterSpacing)).toBe(0)
    // And a screen opened now finds the font's widths.
    const later = await open({ fontFamily: "JB, monospace" })
    expect(renderer(later.terminal)["_widthCache"].get("i", false, false)).toBe(10)
    expect(parseFloat(renderer(later.terminal)["_rowContainer"].style.letterSpacing)).toBe(0)
  })

  it("keep the table of bold, italic and wide strings bounded", async () => {
    const { terminal } = await open()
    const cache = renderer(terminal)["_widthCache"]
    for (let i = 0; i < 5000; i += 1) cache.get(`字${i}`, false, false)
    expect(cache["_shared"].holey.size).toBeLessThanOrEqual(2048)
    // What was dropped is measured again, not lost.
    expect(cache.get("字0", false, false)).toBe(16)
  })

  it("never keep a width that read as 0", async () => {
    broken = true
    await open({ fontFamily: "Unlaid Mono" })
    broken = false
    expect((await open({ fontFamily: "Unlaid Mono" })).reads).toBeGreaterThan(5)
  })
})
