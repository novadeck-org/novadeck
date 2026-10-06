import type { Session, WebContents } from "electron"

import { context, describe, expect, it } from "../test"
import { limitPermissions, ownPage } from "./permissions"

type Check = (contents: unknown, permission: string, origin: string, details: object) => boolean
type Request = (
  contents: unknown,
  permission: string,
  respond: (granted: boolean) => void,
  details: object,
) => void

const appUrl = "http://127.0.0.1:5173/#/projects"

// A window or a view showing `url`.
const contents = (type: string, url: string) =>
  ({ getType: () => type, getURL: () => url }) as unknown as WebContents

// The app's session as its handlers answer a frame of `contents`.
const session = (microphone?: () => Promise<boolean>) => {
  const handlers: { check?: Check; request?: Request } = {}
  const fake = {
    setPermissionCheckHandler: (handler: Check) => (handlers.check = handler),
    setPermissionRequestHandler: (handler: Request) => (handlers.request = handler),
  }
  limitPermissions(fake as unknown as Session, (url) => url === appUrl, microphone)
  const asks = (
    permission: string,
    from = contents("window", appUrl),
    isMainFrame = true,
    media: { mediaTypes?: string[]; mediaType?: string } = {},
  ): { checked: boolean; requested: boolean | undefined } => {
    let requested: boolean | undefined
    handlers.request?.(from, permission, (granted) => (requested = granted), {
      isMainFrame,
      requestingUrl: appUrl,
      ...(media.mediaTypes && { mediaTypes: media.mediaTypes }),
    })
    return {
      checked:
        handlers.check?.(from, permission, "http://127.0.0.1:5173", {
          isMainFrame,
          ...(media.mediaType && { mediaType: media.mediaType }),
        }) ?? true,
      requested,
    }
  }
  // A request that waits on the system, answered when its promise settles.
  const asksLater = async (
    mediaTypes: string[],
    from = contents("window", appUrl),
  ): Promise<boolean | undefined> => {
    let requested: boolean | undefined
    handlers.request?.(from, "media", (granted) => (requested = granted), {
      isMainFrame: true,
      requestingUrl: appUrl,
      mediaTypes,
    })
    await new Promise((settle) => setTimeout(settle, 0))
    return requested
  }
  return { asks, asksLater }
}

describe("the app's permissions", () => {
  context("for the app's own page", () => {
    it("allow reading and writing the clipboard", () => {
      const app = session()
      expect(app.asks("clipboard-read")).toEqual({ checked: true, requested: true })
      expect(app.asks("clipboard-sanitized-write")).toEqual({ checked: true, requested: true })
    })

    it("refuse everything else", () => {
      const app = session()
      for (const permission of ["notifications", "geolocation", "openExternal"])
        expect(app.asks(permission)).toEqual({ checked: false, requested: false })
    })
  })

  context("for the microphone", () => {
    it("allow audio alone, and refuse the camera", async () => {
      const app = session()
      expect(app.asks("media", undefined, true, { mediaType: "audio" }).checked).toBe(true)
      expect(app.asks("media", undefined, true, { mediaType: "video" }).checked).toBe(false)
      expect(app.asks("media", undefined, true, { mediaType: "unknown" }).checked).toBe(false)
      expect(await app.asksLater(["audio"])).toBe(true)
      expect(await app.asksLater(["video"])).toBe(false)
      expect(await app.asksLater(["audio", "video"])).toBe(false)
      expect(await app.asksLater([])).toBe(false)
    })

    it("are granted only as far as the system allows", async () => {
      expect(await session(async () => false).asksLater(["audio"])).toBe(false)
      expect(await session(() => Promise.reject(new Error("no"))).asksLater(["audio"])).toBe(false)
    })

    it("are not asked of the system for a camera or another page", async () => {
      let asked = 0
      const app = session(async () => ++asked > 0)
      await app.asksLater(["video"])
      await app.asksLater(["audio"], contents("window", "https://example.com/"))
      expect(asked).toBe(0)
    })

    it("are refused to a frame inside the page or a live page", () => {
      const app = session()
      const audio = { mediaType: "audio", mediaTypes: ["audio"] }
      expect(app.asks("media", undefined, false, audio)).toEqual({
        checked: false,
        requested: false,
      })
      expect(app.asks("media", contents("webview", appUrl), true, audio)).toEqual({
        checked: false,
        requested: false,
      })
    })
  })

  context("for anything else", () => {
    it("refuse the clipboard to a frame inside the page, another page, or a live page", () => {
      const app = session()
      expect(app.asks("clipboard-read", undefined, false)).toEqual({
        checked: false,
        requested: false,
      })
      expect(app.asks("clipboard-read", contents("window", "https://example.com/"))).toEqual({
        checked: false,
        requested: false,
      })
      expect(app.asks("clipboard-read", contents("webview", appUrl))).toEqual({
        checked: false,
        requested: false,
      })
    })
  })
})

describe("the app's own page", () => {
  context("in development", () => {
    it("is any address on the dev server", () => {
      expect(ownPage("http://127.0.0.1:5173/#/projects", "http://127.0.0.1:5173")).toBe(true)
      expect(ownPage("http://127.0.0.1:5174/", "http://127.0.0.1:5173")).toBe(false)
    })
  })

  context("packaged", () => {
    const index = "file:///opt/novadeck/resources/ui/index.html"

    it("is the packaged page's file", () => {
      expect(ownPage(`${index}#/projects`, index)).toBe(true)
      expect(ownPage("file:///etc/passwd", index)).toBe(false)
      expect(ownPage("https://example.com/opt/novadeck/resources/ui/index.html", index)).toBe(false)
    })
  })

  it("is never an address that can't be parsed, as a frame's before it loads", () => {
    expect(ownPage("", "http://127.0.0.1:5173")).toBe(false)
    expect(ownPage("not an address", "http://127.0.0.1:5173")).toBe(false)
  })
})
