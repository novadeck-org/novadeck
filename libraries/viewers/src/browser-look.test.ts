import { EventEmitter } from "node:events"

import type { BrowserWindow, BrowserWindowConstructorOptions, NativeImage } from "electron"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createLooker,
  lookLoadMs,
  lookPicture,
  lookPictureMs,
  lookSettleMs,
  lookSizes,
  lookWidth,
  maxWaitingLooks,
  maxLookPicture,
} from "./browser-look.js"

afterEach(() => vi.useRealTimers())

// An image as Electron makes one: its width, and what each quality or width encodes to.
const image = (width: number, bytes: (quality: number, width: number) => number): NativeImage => {
  const picture = (at: number): NativeImage =>
    ({
      isEmpty: () => false,
      getSize: () => ({ width: at, height: 10 }),
      resize: ({ width: to }: { width: number }) => picture(to),
      toJPEG: (quality: number) => Buffer.alloc(bytes(quality, at), 1),
    }) as unknown as NativeImage
  return picture(width)
}

describe("a look's picture", () => {
  it("is a JPEG address no wider than a look gets", () => {
    const widths: number[] = []
    const wide = image(2560, (_quality, width) => (widths.push(width), 10))
    expect(lookPicture(wide)).toBe(
      `data:image/jpeg;base64,${Buffer.alloc(10, 1).toString("base64")}`,
    )
    expect(widths).toEqual([lookWidth])
  })

  it("has its quality lowered, then its width halved, until it fits", () => {
    const tried: [number, number][] = []
    // Too large at any quality in full width, and at the width halved once.
    const heavy = image(1280, (quality, width) => {
      tried.push([quality, width])
      return width > 400 ? maxLookPicture : 10
    })
    expect(lookPicture(heavy)).toBeDefined()
    expect(tried.map(([quality]) => quality).slice(0, 4)).toEqual([85, 70, 55, 40])
    expect(tried.at(-1)![1]).toBe(320)
  })

  it("is nothing for an empty image or one that never fits", () => {
    expect(lookPicture({ isEmpty: () => true } as unknown as NativeImage)).toBeUndefined()
    expect(lookPicture(image(1280, () => maxLookPicture))).toBeUndefined()
  })
})

// A hidden window as Electron makes one, with the events a load has.
const windowFor = ({
  draws = true,
  load = (contents: EventEmitter): void => void setTimeout(() => contents.emit("did-stop-loading")),
}: {
  draws?: boolean
  load?: (contents: EventEmitter, url: string) => void
} = {}) => {
  const contents = Object.assign(new EventEmitter(), {
    id: 41,
    destroyed: false,
    url: "",
    audio: [] as boolean[],
    opens: undefined as unknown,
    setAudioMuted(muted: boolean) {
      this.audio.push(muted)
    },
    setWindowOpenHandler(handler: unknown) {
      this.opens = handler
    },
    getURL() {
      return this.url
    },
    getTitle: () => "A page",
    insertCSS: () => Promise.resolve(""),
    loadURL(url: string) {
      this.url = url
      load(this as unknown as EventEmitter, url)
      return Promise.resolve()
    },
    capturePage: () =>
      Promise.resolve(
        draws ? image(1280, () => 10) : ({ isEmpty: () => true } as unknown as NativeImage),
      ),
  })
  const window = {
    webContents: contents,
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    destroy() {
      this.destroyed = true
    },
  }
  return { contents, window }
}

const local = (address: string): boolean => new URL(address).hostname === "localhost"

const setup = (
  options?: Parameters<typeof windowFor>[0],
  emulate: (contents: unknown) => Promise<boolean> = async () => true,
) => {
  const made = windowFor(options)
  const created: BrowserWindowConstructorOptions[] = []
  const forgotten: number[] = []
  const looker = createLooker({
    partition: "persist:pages",
    allow: local,
    forget: (id) => forgotten.push(id),
    emulate: emulate as never,
    create: (each) => {
      created.push(each)
      made.window.destroyed = false
      return made.window as unknown as BrowserWindow
    },
  })
  return { ...made, created, forgotten, looker }
}

const url = "http://localhost:5173/"

describe("a look at a page", () => {
  it("loads in a window nobody sees, in the pages' session, locked down like a pane's page", async () => {
    const { looker, created, contents } = setup()
    await looker.look({ url, layout: "desktop" })
    const [options] = created
    expect(options).toMatchObject({
      show: false,
      focusable: false,
      skipTaskbar: true,
      frame: false,
      useContentSize: true,
      ...lookSizes.desktop,
      webPreferences: {
        partition: "persist:pages",
        offscreen: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    })
    expect(options?.webPreferences).not.toHaveProperty("preload")
    // No popup opens, and nothing it plays is heard.
    expect((contents.opens as () => unknown)()).toEqual({ action: "deny" })
    expect(contents.audio).toEqual([true])
  })

  it("is a phone's screen where the item is switched to one", async () => {
    const { looker, created } = setup()
    const look = await looker.look({ url, layout: "phone" })
    expect(created[0]).toMatchObject(lookSizes.phone)
    expect(look).toMatchObject({ size: lookSizes.phone })
  })

  it("acts as a phone's before its first document, as the pane's page does, where it is switched to one", async () => {
    const steps: string[] = []
    const { looker, contents } = setup(
      {
        load: (each, at) => {
          steps.push(at === url ? "load" : "blank")
          setTimeout(() => each.emit("did-stop-loading"))
        },
      },
      async (emulated) => {
        steps.push(emulated === contents ? "emulate" : "other")
        return true
      },
    )
    await looker.look({ url, layout: "phone" })
    expect(steps).toEqual(["blank", "emulate", "load"])
  })

  it("is a desktop's as it is, with no emulation", async () => {
    const steps: string[] = []
    const { looker } = setup(undefined, async () => (steps.push("emulate"), true))
    await looker.look({ url, layout: "desktop" })
    expect(steps).toEqual([])
  })

  it("isn't taken as a phone's where it can't act as one, rather than shown as something else", async () => {
    const { looker, window } = setup(undefined, async () => false)
    expect(await looker.look({ url, layout: "phone" })).toEqual({
      reason: "The page could not be set up as a phone's.",
    })
    expect(window.destroyed).toBe(true)
  })

  it("answers the picture, where the page ended up, its title and the size it laid out at", async () => {
    const { looker, contents } = setup({
      load: (each, at) => {
        // As a redirect would.
        Object.assign(each, { url: `${at}home` })
        setTimeout(() => each.emit("did-stop-loading"))
      },
    })
    const look = await looker.look({ url, layout: "desktop" })
    expect(look).toEqual({
      picture: `data:image/jpeg;base64,${Buffer.alloc(10, 1).toString("base64")}`,
      url: `${url}home`,
      title: "A page",
      size: { width: 1280, height: 800 },
      troubles: [],
    })
    expect(contents.url).toBe(`${url}home`)
  })

  it("destroys the window whatever comes", async () => {
    const drawn = setup()
    await drawn.looker.look({ url, layout: "desktop" })
    expect(drawn.window.destroyed).toBe(true)
    const blank = setup({ draws: false })
    expect(await blank.looker.look({ url, layout: "desktop" })).toEqual({
      reason: "The page drew nothing to take a picture of.",
    })
    expect(blank.window.destroyed).toBe(true)
    const broken = createLooker({
      partition: "persist:pages",
      allow: local,
      emulate: async () => true,
      create: () => {
        throw new Error("no window")
      },
    })
    expect(await broken.look({ url, layout: "desktop" })).toEqual({
      reason: "The page could not be pictured.",
    })
  })

  it("is refused for anything but an http(s) address and the two layouts", async () => {
    const { looker, created } = setup()
    const refused = await Promise.all(
      [
        "file:///etc/passwd",
        "javascript:1",
        "chrome://gpu",
        "https://example.com/",
        "",
        7,
        undefined,
      ].map((at) => looker.look({ url: at, layout: "desktop" })),
    )
    expect(refused).toEqual(
      refused.map(() => ({ reason: "Novadeck only looks at pages on this machine." })),
    )
    expect(refused).toHaveLength(7)
    expect(await looker.look({ url, layout: "tablet" })).toEqual({
      reason: "That layout is unknown.",
    })
    expect(created).toEqual([])
  })

  it("is one at a time: another asked meanwhile waits its turn, and succeeds", async () => {
    const releases: (() => void)[] = []
    const { looker, created } = setup({
      load: (each) => releases.push(() => each.emit("did-stop-loading")),
    })
    const first = looker.look({ url, layout: "desktop" })
    const second = looker.look({ url, layout: "desktop" })
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    // The second has no window while the first is under way.
    expect(created).toHaveLength(1)
    releases[0]!()
    expect(await first).toHaveProperty("picture")
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    expect(created).toHaveLength(2)
    releases[1]!()
    expect(await second).toHaveProperty("picture")
  })

  it("refuses a look beyond the few that wait", async () => {
    const releases: (() => void)[] = []
    const { looker } = setup({
      load: (each) => releases.push(() => each.emit("did-stop-loading")),
    })
    const looks = Array.from({ length: 1 + maxWaitingLooks }, () =>
      looker.look({ url, layout: "desktop" }),
    )
    expect(await looker.look({ url, layout: "desktop" })).toEqual({
      reason: expect.stringContaining("waiting"),
    })
    // Each in its turn.
    for (let each = 0; each < looks.length; each += 1) {
      // eslint-disable-next-line no-await-in-loop -- Each look starts once the one before ends.
      await vi.waitFor(() => expect(releases).toHaveLength(each + 1))
      releases[each]!()
    }
    const answers = await Promise.all(looks)
    expect(answers.every((answer) => "picture" in answer)).toBe(true)
  })

  it("is a window of its own, none of the app's, until it is destroyed, and is forgotten after", async () => {
    let during: boolean | undefined
    const { looker, window, forgotten } = setup()
    const done = looker.look({ url, layout: "desktop" })
    await vi.waitFor(() => expect(looker.is(window as unknown as BrowserWindow)).toBe(true))
    during = looker.is(window as unknown as BrowserWindow)
    await done
    expect(during).toBe(true)
    expect(looker.is(window as unknown as BrowserWindow)).toBe(false)
    expect(forgotten).toEqual([41])
  })

  it("takes no dialog, which would hold the page until the look gave up", async () => {
    const { looker, created } = setup()
    await looker.look({ url, layout: "desktop" })
    expect(created[0]?.webPreferences).toMatchObject({ disableDialogs: true })
  })

  it("keeps its frames to the pages the host allows, as its navigations and redirects", async () => {
    const prevented: Record<string, boolean[]> = { frame: [], redirect: [], navigate: [] }
    const { looker } = setup({
      load: (each) => {
        const ask = (type: string, key: string, to: string): void => {
          const event = {
            prevented: false,
            preventDefault() {
              this.prevented = true
            },
          }
          // A frame's navigation says where in its event, the others as a second argument.
          if (type === "will-frame-navigate") each.emit(type, Object.assign(event, { url: to }))
          else each.emit(type, event, to)
          prevented[key]!.push(event.prevented)
        }
        ask("will-frame-navigate", "frame", "http://example.com/frame")
        ask("will-frame-navigate", "frame", "http://localhost:3000/frame")
        ask("will-redirect", "redirect", "https://example.com/")
        ask("will-navigate", "navigate", "file:///etc/passwd")
        setTimeout(() => each.emit("did-stop-loading"))
      },
    })
    await looker.look({ url, layout: "desktop" })
    expect(prevented).toEqual({ frame: [true, false], redirect: [true], navigate: [true] })
  })

  it("keeps the page to http(s) addresses by its own redirects", async () => {
    const { looker, contents } = setup({
      load: (each) => {
        const event = {
          prevented: false,
          preventDefault() {
            this.prevented = true
          },
        }
        each.emit("will-redirect", event, "file:///etc/passwd")
        const fine = {
          prevented: false,
          preventDefault() {
            this.prevented = true
          },
        }
        each.emit("will-navigate", fine, "http://localhost:3000/")
        expect([event.prevented, fine.prevented]).toEqual([true, false])
        setTimeout(() => each.emit("did-stop-loading"))
      },
    })
    await looker.look({ url, layout: "desktop" })
    expect(contents.listenerCount("will-redirect")).toBe(1)
  })

  context("while it loads", () => {
    it("tells the errors it logs, requests of its origin that fail, and a load that fails outright", async () => {
      const { looker, contents } = setup({
        load: (each) => {
          each.emit("console-message", {
            level: "error",
            message: "boom",
            sourceId: `${url}app.js`,
            lineNumber: 12,
          })
          // Not errors, and not the page's own origin.
          each.emit("console-message", {
            level: "warning",
            message: "meh",
            sourceId: `${url}app.js`,
            lineNumber: 1,
          })
          each.emit("console-message", {
            level: "error",
            message: "ad",
            sourceId: "https://ads.example/x.js",
            lineNumber: 1,
          })
          expect(looker.failed(41, { url: `${url}api`, status: 500, what: "fetch" })).toBe(true)
          looker.failed(41, { url: "https://ads.example/b", status: 404, what: "img" })
          each.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", url, true)
          // The browser's own page for it fails to get an answer too: the same failure.
          looker.failed(41, { url, status: 0, what: "page" })
          // A navigation that replaced the one loading isn't a failure.
          each.emit("did-fail-load", {}, -3, "ERR_ABORTED", url, true)
          each.emit("did-stop-loading")
        },
      })
      const look = await looker.look({ url, layout: "desktop" })
      expect(look).toMatchObject({
        troubles: [
          { kind: "error", text: "boom", source: `${url}app.js`, line: 12 },
          { kind: "request", url: `${url}api`, status: 500, what: "fetch" },
          { kind: "load", text: "ERR_NAME_NOT_RESOLVED" },
        ],
      })
      expect(contents.id).toBe(41)
    })

    it("hears no failure of a view that isn't its own, nor once it is done", async () => {
      const { looker } = setup()
      expect(looker.failed(41, { url, status: 500, what: "fetch" })).toBe(false)
      await looker.look({ url, layout: "desktop" })
      expect(looker.failed(41, { url, status: 500, what: "fetch" })).toBe(false)
    })

    it("says so when the page is still loading after a while, and pictures what it has", async () => {
      vi.useFakeTimers()
      const { looker } = setup({ load: () => {} })
      const look = looker.look({ url, layout: "desktop" })
      await vi.advanceTimersByTimeAsync(lookLoadMs + lookSettleMs + lookPictureMs)
      expect(await look).toMatchObject({
        picture: expect.stringMatching(/^data:image\/jpeg;base64,/),
        troubles: [{ kind: "load", text: `Still loading after ${lookLoadMs / 1000} seconds.` }],
      })
    })
  })
})

const context = describe
