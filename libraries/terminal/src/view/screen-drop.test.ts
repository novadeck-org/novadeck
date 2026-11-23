import { afterEach, describe as context, describe, expect, it, vi } from "vitest"

import type { Exit } from "../contract.js"
import {
  closeScreens,
  inputOf,
  optionsOf,
  shell,
  shown,
  snapshot,
  streamOf,
  screensOf,
} from "./fakes.test-support.js"
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
afterEach(closeScreens)

const key = "01"

// What a drop hands the page: its files, each with the item that says whether it is a folder.
const dropOf = (files: readonly File[], folders: readonly File[] = []): DataTransfer =>
  ({
    types: ["Files"],
    files,
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
      webkitGetAsEntry: () => ({ isDirectory: folders.includes(file) }),
    })),
  }) as unknown as DataTransfer

const notes = new File(["notes"], "notes.txt", { type: "text/plain" })
const shot = new File([new Uint8Array([1])], "shot.png", { type: "image/png" })
const folder = new File([], "src")

describe("files dropped on a terminal's screen", () => {
  // A running shell whose first screen is `data`, or one that exited as `exit` says, recording
  // what is written to it and what is uploaded; `pathOf` is the owner's.
  const running = ({
    data = "$ ",
    exit = null,
    pathOf,
  }: { data?: string; exit?: Exit | null; pathOf?: (file: File) => string } = {}) => {
    const connection = createStore<ViewLink>("connected")
    const written: string[] = []
    const uploads: string[] = []
    const screens = screensOf(
      optionsOf({
        connection,
        lifecycle: () => shell(),
        waitsAfter: () => true,
        attach: async () => {
          const stream = streamOf([snapshot(data, exit)])
          return { ...stream.attached, write: async (text) => void written.push(text) }
        },
        paste: {
          ...optionsOf().paste,
          upload: async (_, file) => {
            uploads.push(file.name)
            return `/up/${file.name}`
          },
          pathOf,
        },
      }),
    )
    const page = shown(screens, key)
    // Its first draw, which a slow runner (Windows in CI) may take seconds over.
    const ready = () =>
      vi.waitFor(() => expect(page.element.textContent).toContain("$"), { timeout: 5_000 })
    return { ...page, written, uploads, ready, connection }
  }

  context("where the owner knows each file's own path", () => {
    it("types each one's path, in order, as a paste of its own, and uploads nothing", async () => {
      const paths = new Map([
        [notes, "/home/me/notes.txt"],
        [shot, "/home/me/My Shots/shot.png"],
      ])
      const { hold, written, uploads, ready } = running({ pathOf: (file) => paths.get(file) ?? "" })
      await ready()

      expect(hold.takesFiles()).toBe(true)
      hold.dropFiles(dropOf([notes, shot]))

      await vi.waitFor(() =>
        expect(written).toEqual(["/home/me/notes.txt ", "/home/me/My\\ Shots/shot.png "]),
      )
      expect(uploads).toEqual([])
    })

    it("types a folder's own path too", async () => {
      const { hold, written, ready } = running({ pathOf: () => "/home/me/src" })
      await ready()

      hold.dropFiles(dropOf([folder], [folder]))

      await vi.waitFor(() => expect(written).toEqual(["/home/me/src "]))
    })
  })

  context("where it doesn't", () => {
    it("saves each one on the host and types the path there", async () => {
      const { hold, written, uploads, ready } = running()
      await ready()

      hold.dropFiles(dropOf([notes, shot]))

      await vi.waitFor(() => expect(written).toEqual(["/up/notes.txt ", "/up/shot.png "]))
      expect(uploads).toEqual(["notes.txt", "shot.png"])
    })

    it("says a folder can't go, and types the files beside it", async () => {
      const { hold, written, uploads, ready } = running()
      await ready()

      hold.dropFiles(dropOf([folder, notes], [folder]))

      await vi.waitFor(() => expect(written).toEqual(["/up/notes.txt "]))
      expect(uploads).toEqual(["notes.txt"])
      expect(hold.state.getSnapshot().notice).toBe(": A folder can't be uploaded")
    })
  })

  it("focuses the screen it went into, so typing goes on after the paths", async () => {
    const { hold, element, ready } = running({ pathOf: () => "/home/me/notes.txt" })
    await ready()
    document.body.focus()

    hold.dropFiles(dropOf([notes]))

    expect(document.activeElement).toBe(inputOf(element))
  })

  it("takes none in a shell that exited and waits for Enter", async () => {
    const { hold, written, uploads, ready } = running({
      data: "$ exit 1",
      exit: { code: 1, signal: null, ranMs: 5_000 },
    })
    await ready()

    expect(hold.takesFiles()).toBe(false)
    hold.dropFiles(dropOf([notes]))

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(written).toEqual([])
    expect(uploads).toEqual([])
  })

  it("takes none while the host is out of reach", async () => {
    const { hold, ready, connection } = running()
    await ready()

    expect(hold.takesFiles()).toBe(true)
    connection.update(() => "reconnecting")
    expect(hold.takesFiles()).toBe(false)
    connection.update(() => "unavailable")
    expect(hold.takesFiles()).toBe(false)
  })

  it("takes none once let go", async () => {
    const { hold, ready } = running()
    await ready()

    hold.release()

    expect(hold.takesFiles()).toBe(false)
  })
})
