import { afterEach, describe, expect, it, vi } from "vitest"

import { feedbackAboutChannel, feedbackSendChannel } from "../bridge.js"
import {
  feedbackAbout,
  feedbackNoteOf,
  feedbackOrigin,
  feedbackTimeoutMs,
  registerFeedbackIpc,
  sendFeedback,
} from "./feedback"

afterEach(() => vi.useRealTimers())

const about = { version: "0.0.219", os: "linux", arch: "x64" } as const

describe("where feedback goes", () => {
  const origin = (packaged: boolean, env?: string, platform = "linux") =>
    feedbackOrigin({ packaged, platform, env })

  it("is novadeck.dev for a packaged build", () => {
    expect(origin(true)).toBe("https://novadeck.dev")
  })

  it("is nowhere for a development run, so it never posts to production", () => {
    expect(origin(false)).toBeUndefined()
    expect(origin(false, "https://novadeck.dev")).toBeUndefined()
    expect(origin(false, "not an address")).toBeUndefined()
  })

  it("is the local website the variable names, in either build", () => {
    expect(origin(false, "http://127.0.0.1:8788/feedback")).toBe("http://127.0.0.1:8788")
    expect(origin(true, "http://localhost:8788")).toBe("http://localhost:8788")
  })

  it("ignores an address that is not on this computer", () => {
    expect(origin(true, "https://example.test")).toBe("https://novadeck.dev")
  })

  it("is nowhere on a system the website has no name for", () => {
    expect(origin(true, undefined, "freebsd")).toBeUndefined()
  })

  it("names the OS as the website takes it", () => {
    const of = (platform: string) => feedbackAbout({ version: "1.0.0", platform, arch: "arm64" })
    expect(of("darwin")).toEqual({ version: "1.0.0", os: "macos", arch: "arm64" })
    expect(of("win32").os).toBe("windows")
    expect(of("linux").os).toBe("linux")
  })
})

describe("a note from the page", () => {
  it("is a kind or none, and text", () => {
    expect(feedbackNoteOf({ kind: "bug", text: "x" })).toEqual({ kind: "bug", text: "x" })
    expect(feedbackNoteOf({ kind: null, text: "x", extra: 1 })).toEqual({ kind: null, text: "x" })
  })

  it.each([undefined, null, "x", { text: "x" }, { kind: "praise", text: "x" }, { kind: null }])(
    "is nothing for %j",
    (value) => expect(feedbackNoteOf(value)).toBeUndefined(),
  )
})

describe("sending a note", () => {
  const sendWith = (status: number | Error, timeoutMs?: number) => {
    const calls: { url: string; init: RequestInit }[] = []
    const result = sendFeedback(
      { kind: "idea", text: "A shortcut." },
      {
        origin: "https://novadeck.dev",
        about,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        fetch: async (url, init) => {
          calls.push({ url, init })
          if (status instanceof Error) throw status
          return { status }
        },
      },
    )
    return { result, calls }
  }

  it("posts exactly the contract's JSON to /feedback, with only a content type", async () => {
    const { result, calls } = sendWith(204)
    await expect(result).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe("https://novadeck.dev/feedback")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({ "Content-Type": "application/json" })
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "idea",
      text: "A shortcut.",
      version: "0.0.219",
      os: "linux",
      arch: "x64",
    })
    expect(Object.keys(JSON.parse(init.body as string))).toEqual([
      "kind",
      "text",
      "version",
      "os",
      "arch",
    ])
  })

  it("sends a note of no kind as null", async () => {
    const calls: string[] = []
    await sendFeedback(
      { kind: null, text: "Hi" },
      {
        origin: "http://127.0.0.1:8788",
        about,
        fetch: async (_url, init) => {
          calls.push(init.body as string)
          return { status: 204 }
        },
      },
    )
    expect(JSON.parse(calls[0]!).kind).toBeNull()
  })

  it.each([200, 400, 413, 415, 429, 503])("rejects on %i", async (status) => {
    await expect(sendWith(status).result).rejects.toThrow(String(status))
  })

  it("rejects when the network fails", async () => {
    await expect(sendWith(new Error("offline")).result).rejects.toThrow("offline")
  })

  it("rejects when nothing answers within the time", async () => {
    vi.useFakeTimers()
    const result = sendFeedback(
      { kind: null, text: "x" },
      {
        origin: "https://novadeck.dev",
        about,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          }),
      },
    )
    const outcome = result.then(
      () => "sent",
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(feedbackTimeoutMs - 1)
    await Promise.resolve()
    const early = await Promise.race([outcome, Promise.resolve("waiting")])
    expect(early).toBe("waiting")
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe("aborted")
    expect(feedbackTimeoutMs).toBe(15_000)
  })
})

describe("taking the page's requests", () => {
  const registered = (own: boolean, send = vi.fn<() => Promise<void>>(async () => {})) => {
    const handlers = new Map<string, (event: never, value?: unknown) => unknown>()
    registerFeedbackIpc(
      { handle: (channel, listener) => void handlers.set(channel, listener as never) },
      { window: () => (own ? "window" : undefined), about: () => about, send },
    )
    return {
      send,
      about: () => handlers.get(feedbackAboutChannel)!({} as never),
      post: (value: unknown) => handlers.get(feedbackSendChannel)!({} as never, value),
    }
  }

  it("answers the app's own page", async () => {
    const page = registered(true)
    expect(page.about()).toEqual(about)
    await page.post({ kind: "bug", text: "x" })
    expect(page.send).toHaveBeenCalledWith({ kind: "bug", text: "x" })
  })

  it("refuses any other sender, and anything that is not a note", async () => {
    const other = registered(false)
    expect(() => other.about()).toThrow("Not the app")
    await expect(other.post({ kind: null, text: "x" })).rejects.toThrow("Not the app")
    const own = registered(true)
    await expect(own.post({ kind: "praise", text: "x" })).rejects.toThrow("Not a feedback")
    expect(own.send).not.toHaveBeenCalled()
    expect(other.send).not.toHaveBeenCalled()
  })

  it("lets a failed send reject to the page", async () => {
    const page = registered(
      true,
      vi.fn<() => Promise<void>>(() => Promise.reject(new Error("503"))),
    )
    await expect(page.post({ kind: null, text: "x" })).rejects.toThrow("503")
  })
})
