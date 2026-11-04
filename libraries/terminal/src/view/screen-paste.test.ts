import { afterEach, describe as context, describe, expect, it, vi } from "vitest"

import {
  closeScreens,
  emulatorPrototype,
  inputOf,
  openedTerminals,
  optionsOf,
  shown,
  snapshot,
  streamOf,
  screensOf,
} from "./fakes.test-support.js"
import { pasteNoticeMs } from "./screens.js"

// jsdom has no layout observers, media queries or canvas; xterm falls back without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
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

// A screen closes once its session has stayed off screen for its retention; it closes here
// instead, while the file's DOM is still there to take its listeners off.
afterEach(closeScreens)

describe("pasting into a terminal's screen", () => {
  context("when a pasted image can't be saved", () => {
    // Pastes an image into a screen whose upload is refused with `error`.
    const pasteRefused = (error: unknown) => {
      const screens = screensOf(
        optionsOf({
          paste: { ...optionsOf().paste, upload: () => Promise.reject(error) },
        }),
      )
      const { hold, element } = shown(screens, "a")
      vi.spyOn(console, "error").mockImplementation(() => {})
      const event = new Event("paste", { bubbles: true, cancelable: true })
      const image = new File([new Uint8Array([1])], "", { type: "image/png" })
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          items: [{ kind: "file", getAsFile: () => image }],
          getData: () => "",
        },
      })
      inputOf(element).dispatchEvent(event)
      return hold
    }

    it("says why in its state, then lets the notice go", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const hold = pasteRefused(new Error("The host refused it"))
        await vi.advanceTimersByTimeAsync(0)
        expect(hold.state.getSnapshot().notice).toBe("image/png: The host refused it")
        await vi.advanceTimersByTimeAsync(pasteNoticeMs)
        expect(hold.state.getSnapshot().notice).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it("says only that it failed when the host is unreachable", async () => {
      // A failure with no message to give.
      const hold = pasteRefused("unreachable")
      await vi.waitFor(() => expect(hold.state.getSnapshot().notice).toBe("image/png: failed"))
    })
  })

  context("when a file copied in a file manager is pasted where the owner knows its path", () => {
    it("pastes the file's own path, as the owner names it, without uploading", async () => {
      const file = new File(["x"], "notes.txt")
      const upload = vi.fn<() => Promise<string>>(async () => "/u/copy.txt")
      const paste = vi.spyOn(emulatorPrototype(), "paste")
      const screens = screensOf(
        optionsOf({
          paste: {
            ...optionsOf().paste,
            upload,
            pathOf: (pasted) => (pasted === file ? "/home/me/notes.txt" : ""),
          },
        }),
      )
      const { element } = shown(screens, "a")
      const event = new Event("paste", { bubbles: true, cancelable: true })
      Object.defineProperty(event, "clipboardData", {
        value: { files: [file], items: [], getData: () => "" },
      })
      inputOf(element).dispatchEvent(event)
      await vi.waitFor(() => expect(paste).toHaveBeenCalledWith("/home/me/notes.txt "))
      expect(upload).not.toHaveBeenCalled()
    })
  })

  context("when the copy keys are pressed", () => {
    // A running shell's screen with something selected, recording what is written to the
    // shell and to the clipboard.
    const selecting = async (platform: string) => {
      Object.defineProperty(navigator, "platform", { configurable: true, value: platform })
      const written: string[] = []
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: vi.fn<(text: string) => Promise<void>>(
            async (text) => void written.push(text),
          ),
        },
      })
      const opened = openedTerminals()
      const { attached, written: sent } = streamOf([snapshot("$ echo hi\r\n")])
      const screens = screensOf(optionsOf({ attach: async () => attached }))
      const { element } = shown(screens, "01")
      const xterm = opened[0]!
      await vi.waitFor(() =>
        expect(xterm.buffer.active.getLine(0)?.translateToString()).toContain("echo hi"),
      )
      xterm.select(2, 0, 4)
      const press = (init: KeyboardEventInit) => {
        const event = new KeyboardEvent("keydown", {
          keyCode: 67,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          ...init,
        })
        inputOf(element).dispatchEvent(event)
        return event
      }
      return { xterm, element, press, written, sent }
    }
    afterEach(() => {
      Reflect.deleteProperty(navigator, "clipboard")
      Reflect.deleteProperty(navigator, "platform")
    })

    it.each(["Linux x86_64", "Win32"])(
      "copies the selection with Ctrl+C on %s, clears it and sends the program nothing",
      async (platform) => {
        const page = await selecting(platform)
        expect(page.xterm.getSelection()).toBe("echo")
        expect(page.press({ key: "c", code: "KeyC" }).defaultPrevented).toBe(true)
        expect(page.written).toEqual(["echo"])
        expect(page.xterm.hasSelection()).toBe(false)
        expect(page.sent).toEqual([])
      },
    )

    it("sends Ctrl+C to the program once nothing is selected", async () => {
      const page = await selecting("Linux x86_64")
      page.xterm.clearSelection()
      page.press({ key: "c", code: "KeyC" })
      expect(page.written).toEqual([])
      expect(page.sent).toEqual(["\u0003"])
    })

    it.each(["Linux x86_64", "Win32"])(
      "leaves Ctrl+V and Ctrl+Shift+V to the browser and swallows Ctrl+Shift+C without a selection on %s",
      async (platform) => {
        const page = await selecting(platform)
        const v = { key: "v", code: "KeyV", keyCode: 86 }
        expect(page.press(v).defaultPrevented).toBe(false)
        expect(page.press({ ...v, key: "V", shiftKey: true }).defaultPrevented).toBe(false)
        page.xterm.clearSelection()
        expect(page.press({ key: "C", code: "KeyC", shiftKey: true }).defaultPrevented).toBe(true)
        expect(page.sent).toEqual([])
        expect(page.written).toEqual([])
      },
    )

    it("keeps Ctrl+C the program's on macOS, where ⌘C copies", async () => {
      const page = await selecting("MacIntel")
      page.press({ key: "c", code: "KeyC" })
      expect(page.written).toEqual([])
      expect(page.sent).toEqual(["\u0003"])
    })

    it("fills a copy event, as ⌘C raises it through the menu, with the selection", async () => {
      const page = await selecting("MacIntel")
      const data = { setData: vi.fn<(type: string, value: string) => void>() }
      const event = Object.assign(new Event("copy", { bubbles: true, cancelable: true }), {
        clipboardData: data,
      })
      inputOf(page.element).dispatchEvent(event)
      expect(data.setData).toHaveBeenCalledWith("text/plain", "echo")
    })
  })
})
