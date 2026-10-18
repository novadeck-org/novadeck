import { afterEach, describe as context, describe, expect, it, vi } from "vitest"

import {
  closeViews,
  emulatorPrototype,
  exited,
  inputOf,
  later,
  openedTerminals,
  optionsOf,
  shell,
  shown,
  snapshot,
  streamOf,
  viewsOf,
} from "./fakes.test-support.js"
import { ctrlVHoldMs } from "./paste.js"
import { pasteNoticeMs } from "./screens.js"
import { createStore, type ViewLink } from "./view-state.js"

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
afterEach(closeViews)

// An image on the clipboard.
const clipboardImage = () => ({
  types: ["image/png"],
  getType: async () => new Blob([new Uint8Array([1])], { type: "image/png" }),
})

describe("pasting into a terminal's screen", () => {
  context("when a pasted image can't be saved", () => {
    // Pastes an image into a screen whose upload is refused with `error`.
    const pasteRefused = (error: unknown) => {
      const views = viewsOf(
        optionsOf({
          paste: { ...optionsOf().paste, upload: () => Promise.reject(error) },
        }),
      )
      const { hold, element } = shown(views, "a")
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
        const hold = pasteRefused(new Error("The runner refused it"))
        await vi.advanceTimersByTimeAsync(0)
        expect(hold.state.getSnapshot().notice).toBe("image/png: The runner refused it")
        await vi.advanceTimersByTimeAsync(pasteNoticeMs)
        expect(hold.state.getSnapshot().notice).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it("says only that it failed when the runner is unreachable", async () => {
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
      const views = viewsOf(
        optionsOf({
          paste: {
            ...optionsOf().paste,
            upload,
            pathOf: (pasted) => (pasted === file ? "/home/me/notes.txt" : ""),
          },
        }),
      )
      const { element } = shown(views, "a")
      const event = new Event("paste", { bubbles: true, cancelable: true })
      Object.defineProperty(event, "clipboardData", {
        value: { files: [file], items: [], getData: () => "" },
      })
      inputOf(element).dispatchEvent(event)
      await vi.waitFor(() => expect(paste).toHaveBeenCalledWith("/home/me/notes.txt "))
      expect(upload).not.toHaveBeenCalled()
    })
  })

  context("when Ctrl+V is pressed on Linux or Windows", () => {
    // A running shell's screen in a browser that lets the page read the clipboard,
    // recording what is written to the shell. `read` answers the clipboard, `upload` saves.
    const typing = (options: {
      read: () => Promise<unknown[]>
      upload?: (key: string, file: { readonly name: string }) => Promise<string>
    }) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { read: options.read },
      })
      Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: { query: async () => Object.assign(new EventTarget(), { state: "granted" }) },
      })
      const connection = createStore<ViewLink>("connected")
      const opened = openedTerminals()
      const { attached, written, push } = streamOf([snapshot("$ ")])
      const entry = { closed: false }
      const views = viewsOf(
        optionsOf({
          attach: async () => attached,
          connection,
          lifecycle: () => shell({ closed: entry.closed }),
          // The owner's rule: a shell that exits with a failure waits for Enter.
          waitsAfter: () => true,
          paste: {
            ...optionsOf().paste,
            upload: options.upload ?? (async (_key, file) => `/u/${file.name.replace(/\d/g, "0")}`),
          },
        }),
      )
      const { hold, element } = shown(views, "01")
      const xterm = () => opened[0]!
      const press = () =>
        inputOf(element).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "v",
            code: "KeyV",
            keyCode: 86,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
      const ready = () =>
        vi.waitFor(() =>
          expect(xterm().buffer.active.getLine(0)?.translateToString()).toContain("$"),
        )
      // The shell's exit, as the stream tells it.
      const exit = () => push(exited({ code: 1, signal: null, ranMs: 60_000 }, 2))
      return { hold, element, written, press, ready, xterm, exit, connection, entry }
    }
    afterEach(() => {
      Reflect.deleteProperty(navigator, "clipboard")
      Reflect.deleteProperty(navigator, "permissions")
    })

    it("pastes an image-only clipboard's path, with what was typed meanwhile after it", async () => {
      const clipboard = later<unknown[]>()
      const typed = typing({ read: () => clipboard.promise })
      await typed.ready()
      expect(typed.press()).toBe(false)
      typed.xterm().input("ls")
      clipboard.give([clipboardImage()])
      await vi.waitFor(() => expect(typed.written).toHaveLength(2))
      expect(typed.written).toEqual(["/u/pasted-00000000-000000.png ", "ls"])
    })

    it("sends Ctrl+V, then what was typed, for a clipboard of text", async () => {
      const typed = typing({
        read: async () => [{ types: ["text/plain"], getType: async () => new Blob(["hi"]) }],
      })
      await typed.ready()
      typed.press()
      typed.xterm().input("w")
      await vi.waitFor(() => expect(typed.written).toEqual(["\u0016", "w"]))
      expect(typed.hold.state.getSnapshot().notice).toBeNull()
    })

    it("queues mouse reports and pasted text behind it too", async () => {
      const clipboard = later<unknown[]>()
      const typed = typing({ read: () => clipboard.promise })
      await typed.ready()
      typed.press()
      // A mouse report, as xterm's own mouse handling sends it from its core.
      const core = Reflect.get(typed.xterm(), "_core") as {
        coreService: { triggerBinaryEvent: (data: string) => void }
      }
      core.coreService.triggerBinaryEvent("\u001b[M !!")
      // Ctrl+Shift+V of text, which the emulator pastes itself.
      const paste = new Event("paste", { bubbles: true, cancelable: true })
      Object.defineProperty(paste, "clipboardData", {
        value: {
          files: [],
          items: [],
          getData: (type: string) => (type === "text/plain" ? "echo" : ""),
        },
      })
      inputOf(typed.element).dispatchEvent(paste)
      expect(typed.written).toEqual([])
      clipboard.give([])
      await vi.waitFor(() => expect(typed.written).toEqual(["\u0016", "\u001b[M !!", "echo"]))
    })

    it("lets typing go after a while when the image is slow to upload, pasting its path later", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const saved = later<string>()
        const typed = typing({ read: async () => [clipboardImage()], upload: () => saved.promise })
        await vi.advanceTimersByTimeAsync(0)
        await typed.ready()
        typed.press()
        typed.xterm().input("ls")
        await vi.advanceTimersByTimeAsync(1_000)
        expect(typed.written).toEqual([])
        await vi.advanceTimersByTimeAsync(ctrlVHoldMs)
        expect(typed.written).toEqual(["ls"])
        saved.give("/u/late.png")
        await vi.advanceTimersByTimeAsync(0)
        expect(typed.written).toEqual(["ls", "/u/late.png "])
      } finally {
        vi.useRealTimers()
      }
    })

    it("sends nothing it held once the shell exited meanwhile", async () => {
      const clipboard = later<unknown[]>()
      const typed = typing({ read: () => clipboard.promise })
      await typed.ready()
      typed.press()
      typed.xterm().input("ls")
      typed.exit()
      await new Promise((resolve) => setTimeout(resolve, 10))
      clipboard.give([])
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(typed.written).toEqual([])
    })

    it("holds back its Ctrl+V once typing is locked meanwhile", async () => {
      const clipboard = later<unknown[]>()
      const typed = typing({ read: () => clipboard.promise })
      await typed.ready()
      typed.press()
      typed.connection.update(() => "reconnecting")
      clipboard.give([])
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(typed.written).toEqual([])
    })

    it("pastes and sends nothing once the terminal's screen is gone", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const saved = later<string>()
        const typed = typing({ read: async () => [clipboardImage()], upload: () => saved.promise })
        await vi.advanceTimersByTimeAsync(0)
        await typed.ready()
        typed.press()
        typed.xterm().input("ls")
        await vi.advanceTimersByTimeAsync(0)
        // Nobody shows it and its terminal closes, so the screen closes a moment later, while
        // the image uploads.
        typed.hold.release({ unmount: true })
        typed.entry.closed = true
        await vi.advanceTimersByTimeAsync(1_000)
        saved.give("/u/late.png")
        await vi.advanceTimersByTimeAsync(ctrlVHoldMs)
        expect(typed.written).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
