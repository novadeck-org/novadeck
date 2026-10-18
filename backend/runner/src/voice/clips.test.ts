import { DomainError } from "../errors.js"
import { describe, expect, it } from "../test.js"
import { Clips, maxClips, maxClipBytes, maxClipsPerOwner } from "./clips.js"

describe("clips", () => {
  it("joins parts at the offsets they name", () => {
    const clips = new Clips()

    expect(clips.write("owner", "a", 0, Buffer.from([1, 2]))).toBe(true)
    expect(clips.write("owner", "a", 2, Buffer.from([3, 4]))).toBe(false)

    expect(clips.get("owner", "a")).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it("overwrites a part sent again", () => {
    const clips = new Clips()
    clips.write("owner", "a", 0, Buffer.from([1, 2, 3, 4]))
    clips.write("owner", "a", 2, Buffer.from([9, 9]))

    expect(clips.get("owner", "a")).toEqual(Buffer.from([1, 2, 9, 9]))
  })

  it("fills a gap with silence", () => {
    const clips = new Clips()
    clips.write("owner", "a", 0, Buffer.from([1]))
    clips.write("owner", "a", 4, Buffer.from([7, 7]))

    expect(clips.get("owner", "a")).toEqual(Buffer.from([1, 0, 0, 0, 7, 7]))
  })

  it("refuses a clip that does not begin at its start, as after its beginning was lost", () => {
    const clips = new Clips()

    expect(() => clips.write("owner", "a", 4, Buffer.from([7, 7]))).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    expect(clips.get("owner", "a")).toBeUndefined()
  })

  it("keeps clips apart and forgets a discarded one", () => {
    const clips = new Clips()
    clips.write("owner", "a", 0, Buffer.from([1]))
    clips.write("owner", "b", 0, Buffer.from([2]))
    clips.discard("owner", "a")

    expect(clips.get("owner", "a")).toBeUndefined()
    expect(clips.get("owner", "b")).toEqual(Buffer.from([2]))
  })

  it("refuses audio past two minutes, leaving the clip as it was", () => {
    const clips = new Clips()
    clips.write("owner", "a", 0, Buffer.from([1]))

    expect(() => clips.write("owner", "a", maxClipBytes, Buffer.from([1]))).toThrow(DomainError)
    expect(() => clips.write("owner", "a", maxClipBytes - 1, Buffer.from([1, 1]))).toThrow(
      "UPLOAD_TOO_LARGE",
    )
    expect(clips.get("owner", "a")).toEqual(Buffer.from([1]))
    expect(() => clips.write("owner", "a", maxClipBytes - 1, Buffer.from([1]))).not.toThrow()
  })

  it("forgets a clip nobody touched for five minutes when another is written", () => {
    let now = 0
    const clips = new Clips(() => now)
    clips.write("owner", "old", 0, Buffer.from([1]))
    now = 4 * 60_000
    clips.write("owner", "new", 0, Buffer.from([1]))
    expect(clips.get("owner", "old")).toBeDefined()
    now = 6 * 60_000
    clips.write("owner", "new", 0, Buffer.from([1]))

    expect(clips.get("owner", "old")).toBeUndefined()
    expect(clips.get("owner", "new")).toBeDefined()
  })

  it("joins a part far from the start with those before it", () => {
    const clips = new Clips()
    clips.write("owner", "a", 0, Buffer.from([1]))
    clips.write("owner", "a", maxClipBytes - 1, Buffer.from([2]))
    clips.write("owner", "a", 70_000, Buffer.from([3, 3]))

    const pcm = clips.get("owner", "a")
    expect(pcm).toHaveLength(maxClipBytes)
    expect([pcm?.[0], pcm?.[1], pcm?.[70_000], pcm?.[70_001], pcm?.at(-1)]).toEqual([1, 0, 3, 3, 2])
  })

  it("keeps one owner's clips from another, and drops an owner's on release", () => {
    const clips = new Clips()
    clips.write("one", "a", 0, Buffer.from([1]))
    clips.write("two", "a", 0, Buffer.from([2]))

    expect(clips.get("one", "a")).toEqual(Buffer.from([1]))
    expect(clips.get("two", "a")).toEqual(Buffer.from([2]))
    clips.release("one")

    expect(clips.get("one", "a")).toBeUndefined()
    expect(clips.get("two", "a")).toEqual(Buffer.from([2]))
  })

  it("refuses more recordings at once than an owner, or all owners, may have", () => {
    const clips = new Clips()
    for (let index = 0; index < maxClipsPerOwner; index += 1)
      clips.write("one", `clip-${index}`, 0, Buffer.from([1]))

    expect(() => clips.write("one", "more", 0, Buffer.from([1]))).toThrow("Too many recordings")
    expect(() => clips.write("one", "clip-0", 1, Buffer.from([1]))).not.toThrow()
    clips.discard("one", "clip-0")
    expect(() => clips.write("one", "more", 0, Buffer.from([1]))).not.toThrow()

    for (let index = 0; clips.size < maxClips; index += 1)
      clips.write(`owner-${index}`, "a", 0, Buffer.from([1]))
    expect(() => clips.write("another", "a", 0, Buffer.from([1]))).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT" }),
    )
  })
})
