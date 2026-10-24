// @vitest-environment jsdom
import type { Terminal as XTerminal } from "@xterm/xterm"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

// The app's bundler loads xterm's ES bundle and Node loads the CommonJS one; the patch is made
// in both, so the tests run against each.
type Terminal = XTerminal
let Terminal: typeof XTerminal
const bundles = ["xterm.js", "xterm.mjs"]

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
    _shared: { holey: Map<string, number>; prev?: Map<string, number> }
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

describe.each(bundles)("the DOM renderer's width measurements in lib/%s", (bundle) => {
  beforeAll(async () => {
    Terminal = (
      (await import(/* @vite-ignore */ `@xterm/xterm/lib/${bundle}`)) as {
        Terminal: typeof XTerminal
      }
    ).Terminal
  })

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

  it("keep what screens still draw, however many screens there are", async () => {
    // Three screens of 1500 distinct wide characters each: more than the table held before it
    // was made to keep what is in use, and every one of them drawn again and again.
    const screens = await Promise.all(
      [0, 1, 2].map(async (n) => {
        const { terminal } = await open({ cols: 110, rows: 30 })
        let text = ""
        for (let i = 0; i < 1500; i += 1) {
          text += String.fromCodePoint(0x4e00 + n * 1500 + i)
          if ((i + 1) % 50 === 0) text += "\r\n"
        }
        await new Promise<void>((done) => terminal.write(text, done))
        return terminal
      }),
    )
    const pass = (): number => {
      const before = reads
      screens.forEach((terminal) => renderService(terminal)["_renderRows"](0, terminal.rows - 1))
      return reads - before
    }
    expect(pass()).toBeGreaterThan(4000)
    expect([pass(), pass(), pass()]).toEqual([0, 0, 0])
  })

  it("keep a string in use across the table's turning over, and stay bounded", async () => {
    const { terminal } = await open()
    const cache = renderer(terminal)["_widthCache"]
    cache.get("hot字", false, false)
    for (let i = 0; i < 9000; i += 1) cache.get(`字${i}`, false, false)
    // The table turned over once: "hot字" went with the old generation to the second table.
    expect(cache["_shared"].holey.has("hot字")).toBe(false)
    const before = reads
    expect(cache.get("hot字", false, false)).toBe(32)
    expect(reads).toBe(before)
    expect(cache["_shared"].holey.has("hot字")).toBe(true)
    // However many strings come, the two tables stay within two generations.
    for (let i = 9000; i < 40000; i += 1) cache.get(`字${i}`, false, false)
    const { holey, prev } = cache["_shared"]
    expect(holey.size + (prev?.size ?? 0)).toBeLessThanOrEqual(2 * 8192)
  })

  it("never keep a width that read as 0", async () => {
    broken = true
    await open({ fontFamily: "Unlaid Mono" })
    broken = false
    expect((await open({ fontFamily: "Unlaid Mono" })).reads).toBeGreaterThan(5)
  })
})
