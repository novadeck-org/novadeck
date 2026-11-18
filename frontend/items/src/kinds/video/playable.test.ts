import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
import { playable } from "./playable"

// jsdom loads no media: an element tells nothing unless a test fires its events.
const made: HTMLMediaElement[] = []
const revoked: string[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:probe",
      revokeObjectURL: (url: string) => revoked.push(url),
    }),
  )
  const create = document.createElement.bind(document)
  vi.spyOn(document, "createElement").mockImplementation((name: string) => {
    const element = create(name)
    if (element instanceof HTMLMediaElement) {
      element.load = () => {}
      made.push(element)
    }
    return element
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  made.length = 0
  revoked.length = 0
})

describe("whether the browser can play a file's bytes", () => {
  it("can once it reads the file's length", async () => {
    const plays = playable(new Blob(["a"]), "audio")
    made[0]!.dispatchEvent(new Event("loadedmetadata"))
    await expect(plays).resolves.toBe(true)
    expect(made[0]!.tagName).toBe("AUDIO")
    expect(revoked).toEqual(["blob:probe"])
  })

  it("can't where it says it can't", async () => {
    const plays = playable(new Blob(["a"]))
    made[0]!.dispatchEvent(new Event("error"))
    await expect(plays).resolves.toBe(false)
  })

  it("can't where it says nothing for a while, and lets the bytes go", async () => {
    const plays = playable(new Blob(["a"]), "video", 1000)
    await vi.advanceTimersByTimeAsync(999)
    expect(revoked).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await expect(plays).resolves.toBe(false)
    expect(revoked).toEqual(["blob:probe"])
    // A word that comes late changes nothing.
    made[0]!.dispatchEvent(new Event("loadedmetadata"))
    expect(revoked).toEqual(["blob:probe"])
  })
})
