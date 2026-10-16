import type { UpdateOffer } from "../model/update"
import { describe, expect, it } from "../test"
import { watchedAfter } from "./UpdateProgress"

const offer = (kind: UpdateOffer["kind"], version = "0.0.80"): UpdateOffer =>
  kind === "downloading" ? { kind, version, percent: 10 } : { kind, version }

describe("watchedAfter", () => {
  it("starts watching a version when it is heard downloading", () => {
    expect(watchedAfter(undefined, offer("downloading"))).toEqual({
      version: "0.0.80",
      moment: "progress",
    })
  })

  it("finishes the version it watched when that turns ready", () => {
    const watched = { version: "0.0.80", moment: "progress" } as const
    expect(watchedAfter(watched, offer("ready"))).toEqual({ ...watched, moment: "finished" })
  })

  it("keeps a finished or fading bar through the same ready offer heard again", () => {
    const finished = { version: "0.0.80", moment: "finished" } as const
    expect(watchedAfter(finished, offer("ready"))).toBe(finished)
    const fading = { version: "0.0.80", moment: "fading" } as const
    expect(watchedAfter(fading, offer("ready"))).toBe(fading)
  })

  it("watches nothing for a ready or available offer that was not downloading here", () => {
    expect(watchedAfter(undefined, offer("ready"))).toBeUndefined()
    expect(watchedAfter(undefined, offer("available"))).toBeUndefined()
    expect(watchedAfter(undefined, null)).toBeUndefined()
  })

  it("ends the bar when the download fails, is withdrawn, or another version is ready", () => {
    const watched = { version: "0.0.80", moment: "progress" } as const
    expect(watchedAfter(watched, offer("retrying"))).toEqual({ ...watched, moment: "gone" })
    expect(watchedAfter(watched, offer("available"))).toEqual({ ...watched, moment: "gone" })
    expect(watchedAfter(watched, null)).toEqual({ ...watched, moment: "gone" })
    expect(watchedAfter(watched, offer("ready", "0.0.81"))).toEqual({ ...watched, moment: "gone" })
  })

  it("follows a newer download in place of the one watched", () => {
    const watched = { version: "0.0.80", moment: "finished" } as const
    expect(watchedAfter(watched, offer("downloading", "0.0.81"))).toEqual({
      version: "0.0.81",
      moment: "progress",
    })
  })

  it("stays gone once gone", () => {
    const gone = { version: "0.0.80", moment: "gone" } as const
    expect(watchedAfter(gone, offer("ready"))).toBe(gone)
  })
})
