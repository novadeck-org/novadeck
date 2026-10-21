import { randomBytes } from "node:crypto"

import { describe, expect, it } from "../test.js"
import { createTranscriptSealer, sealedPrefix, transcriptsAvailable } from "./sealing.js"

const sealerOf = async (key: Uint8Array | null = randomBytes(32)) => {
  const sealer = createTranscriptSealer(Promise.resolve(key))
  await sealer.ready
  return sealer
}

describe("sealing transcripts", () => {
  it("opens what it sealed for the same terminal, and seals each time anew", async () => {
    const sealer = await sealerOf()
    const text = "$ echo hi\nhi\né\u{1f600}"
    const sealed = sealer.seal(text, "a")!
    expect(sealed.startsWith(sealedPrefix)).toBe(true)
    expect(sealed).not.toContain("echo hi")
    expect(sealer.open(sealed, "a")).toBe(text)
    expect(sealer.seal(text, "a")).not.toBe(sealed)
    expect(sealer.open(sealer.seal("", "a")!, "a")).toBe("")
  })

  it("does not open a value for another terminal, tampered, plain or of another key", async () => {
    const key = randomBytes(32)
    const sealer = await sealerOf(key)
    const sealed = sealer.seal("secret screen", "a")!
    expect(sealer.open(sealed, "b")).toBeNull()
    const bytes = Buffer.from(sealed.slice(sealedPrefix.length), "base64")
    for (const at of [0, 12, bytes.length - 1]) {
      const copy = Buffer.from(bytes)
      copy[at] = copy[at]! ^ 1
      expect(sealer.open(sealedPrefix + copy.toString("base64"), "a")).toBeNull()
    }
    expect(sealer.open(sealedPrefix + bytes.subarray(0, 20).toString("base64"), "a")).toBeNull()
    expect(sealer.open("secret screen", "a")).toBeNull()
    expect(sealer.open("", "a")).toBeNull()
    expect((await sealerOf()).open(sealed, "a")).toBeNull()
    expect((await sealerOf(key)).open(sealed, "a")).toBe("secret screen")
  })

  it("counts a key of the wrong length, a refused one or a failed one as none", async () => {
    const sealers = [new Uint8Array(31), new Uint8Array(33), null, undefined].map((key) =>
      createTranscriptSealer(key === undefined ? undefined : Promise.resolve(key)),
    )
    expect(await Promise.all(sealers.map((sealer) => sealer.ready))).toEqual([
      false,
      false,
      false,
      false,
    ])
    expect(sealers.map((sealer) => sealer.seal("text", "a"))).toEqual([null, null, null, null])
    const failed = createTranscriptSealer(Promise.reject(new Error("locked")))
    await expect(failed.ready).resolves.toBe(false)
    const ready = await sealerOf()
    await expect(ready.ready).resolves.toBe(true)
  })

  it("tells clients transcripts are available while a key is awaited, not once there is none", async () => {
    const waiting = createTranscriptSealer(new Promise(() => {}))
    await expect(transcriptsAvailable(waiting, 10)).resolves.toBe(true)
    await expect(transcriptsAvailable(createTranscriptSealer(Promise.resolve(null)))).resolves.toBe(
      false,
    )
    await expect(transcriptsAvailable(await sealerOf())).resolves.toBe(true)
  })
})
