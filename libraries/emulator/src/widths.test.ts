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

// jsdom lays nothing out, so every measure element reads as 8 px a glyph, and the reads are
// counted: one per glyph xterm's DOM renderer measures. `broken` makes them read 0, as an
// element with no layout does.
let reads = 0
let broken = false
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement) {
    if (!this.closest(".xterm-width-cache-measure-container")) return 0
    reads += 1
    return broken ? 0 : (this.textContent?.length ?? 0) * 8
  },
})

const hosts: HTMLElement[] = []
const terminals: Terminal[] = []
type Core = {
  _core: {
    _renderService: {
      _renderRows(first: number, last: number): void
      _renderer: { value: { handleCharSizeChanged(): void } }
    }
  }
}
// xterm keeps the renderer private; the test reaches it by name, as the app never does.
const renderService = (terminal: Terminal) =>
  (terminal as unknown as Core)["_core"]["_renderService"]

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
  // The page's shared measurements, so each test starts with none.
  Reflect.deleteProperty(document, Symbol.for("novadeck.xterm.widths"))
})

describe("the DOM renderer's width measurements", () => {
  it("are shared by screens drawing with the same font", async () => {
    const first = await open()
    expect(first.reads).toBeGreaterThan(5)
    expect((await open()).reads).toBe(0)
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

  it("are measured again by later screens after a clear on that font", async () => {
    const first = await open()
    expect((await open()).reads).toBe(0)
    // xterm clears a screen's cache when its character size changes, a web font loading among
    // the causes.
    renderService(first.terminal)["_renderer"].value.handleCharSizeChanged()
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

  it("never keep a width that read as 0", async () => {
    broken = true
    await open({ fontFamily: "Unlaid Mono" })
    broken = false
    expect((await open({ fontFamily: "Unlaid Mono" })).reads).toBeGreaterThan(5)
  })
})
