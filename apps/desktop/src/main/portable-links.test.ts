import type { WhatsNew } from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { vi } from "vitest"

import { openPortableDownloadChannel, showDataFolderChannel, updateNewsChannel } from "../bridge.js"
import { describe, expect, it } from "../test"
import { portableDownloadUrl, registerPortableLinksIpc, shownPath } from "./portable-links"

describe("where a path is shown", () => {
  it("abbreviates the home folder as ~ on Linux and macOS", () => {
    const home = "/home/me"
    expect(shownPath("/home/me/.config/novadeck", { platform: "linux", home })).toBe(
      "~/.config/novadeck",
    )
    expect(
      shownPath("/Users/me/Library/Application Support/novadeck", {
        platform: "darwin",
        home: "/Users/me",
      }),
    ).toBe("~/Library/Application Support/novadeck")
  })

  it("leaves a path outside the home folder, and a home that only shares a prefix, alone", () => {
    expect(shownPath("/home/mex/a", { platform: "linux", home: "/home/me" })).toBe("/home/mex/a")
    expect(shownPath("/home/me", { platform: "linux", home: "/home/me" })).toBe("/home/me")
    expect(shownPath("/a", { platform: "linux", home: "/" })).toBe("/a")
  })

  it("shows the full path on Windows", () => {
    const path = "C:\\Users\\me\\AppData\\Roaming\\novadeck"
    expect(shownPath(path, { platform: "win32", home: "C:\\Users\\me" })).toBe(path)
  })
})

describe("the download page of a portable copy", () => {
  it("is the website's, at the section for the system", () => {
    expect(portableDownloadUrl("darwin")).toBe("https://novadeck.dev/download#macos")
    expect(portableDownloadUrl("win32")).toBe("https://novadeck.dev/download#windows")
    expect(portableDownloadUrl("linux")).toBe("https://novadeck.dev/download#linux")
  })

  it("is none for a system Novadeck is not released for", () => {
    expect(portableDownloadUrl("freebsd")).toBeUndefined()
  })
})

type Listener = (event: IpcMainEvent & IpcMainInvokeEvent) => unknown

const registered = (options: { own?: boolean; portable?: boolean } = {}) => {
  const listeners = new Map<string, Listener>()
  const calls: string[] = []
  const logged: string[] = []
  const news: WhatsNew = { version: "0.6.0", highlights: [{ title: "T", line: "L" }] }
  registerPortableLinksIpc(
    {
      on: (name, listener) => void listeners.set(name, listener as Listener),
      handle: (name, listener) => void listeners.set(name, listener as Listener),
    },
    {
      window: () => (options.own === false ? undefined : "window"),
      portable: options.portable ?? true,
      openDownload: async (url) => void calls.push(`open ${url}`),
      showDataFolder: () => void calls.push("folder"),
      news: async () => {
        calls.push("news")
        return news
      },
      log: (message) => void logged.push(message),
    },
  )
  const send = (name: string): unknown =>
    listeners.get(name)?.({} as IpcMainEvent & IpcMainInvokeEvent)
  return { send, calls, logged, news }
}

describe("taking the page's requests of a portable copy", () => {
  it("opens the download page for this system, shows the data folder and tells the news, for the app's own window", async () => {
    const { send, calls, news } = registered()
    expect(send(openPortableDownloadChannel)).toBeUndefined()
    send(showDataFolderChannel)
    expect(await send(updateNewsChannel)).toEqual(news)
    expect(calls).toEqual([`open ${portableDownloadUrl(process.platform)}`, "folder", "news"])
  })

  it("opens no page from a copy that is not portable", () => {
    const { send, calls } = registered({ portable: false })
    send(openPortableDownloadChannel)
    expect(calls).toEqual([])
  })

  it("ignores any other sender, and tells it there is nothing new", async () => {
    const { send, calls } = registered({ own: false })
    send(openPortableDownloadChannel)
    send(showDataFolderChannel)
    expect(await send(updateNewsChannel)).toBeUndefined()
    expect(calls).toEqual([])
  })

  it("logs a failure to open and does not throw", async () => {
    const logged: string[] = []
    const listeners = new Map<string, Listener>()
    registerPortableLinksIpc(
      { on: (name, listener) => void listeners.set(name, listener as Listener), handle: () => {} },
      {
        window: () => "window",
        portable: true,
        openDownload: () => Promise.reject(new Error("no browser")),
        showDataFolder: () => {
          throw new Error("gone")
        },
        news: async () => undefined,
        log: (message) => void logged.push(message),
      },
    )
    expect(() => listeners.get(openPortableDownloadChannel)!({} as never)).not.toThrow()
    expect(() => listeners.get(showDataFolderChannel)!({} as never)).not.toThrow()
    await vi.waitFor(() => expect(logged).toHaveLength(2))
    expect(logged.toSorted()).toEqual([
      "The data folder was not shown.",
      "The download page did not open.",
    ])
  })

  it("answers nothing new when reading the news fails", async () => {
    const listeners = new Map<string, Listener>()
    registerPortableLinksIpc(
      { on: () => {}, handle: (name, listener) => void listeners.set(name, listener as Listener) },
      {
        window: () => "window",
        portable: true,
        openDownload: () => {},
        showDataFolder: () => {},
        news: () => Promise.reject(new Error("offline")),
        log: () => {},
      },
    )
    expect(await listeners.get(updateNewsChannel)!({} as never)).toBeUndefined()
  })
})
