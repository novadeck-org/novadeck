import { describe, expect, it } from "../test.js"
import { wav } from "./wav.js"

describe("a WAV file", () => {
  it("holds 16 kHz mono 16-bit PCM behind a 44-byte header", () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0])
    const file = wav(pcm)

    expect(file.length).toBe(44 + pcm.length)
    expect(file.toString("ascii", 0, 4)).toBe("RIFF")
    expect(file.readUInt32LE(4)).toBe(36 + pcm.length)
    expect(file.toString("ascii", 8, 16)).toBe("WAVEfmt ")
    expect(file.readUInt16LE(20)).toBe(1)
    expect(file.readUInt16LE(22)).toBe(1)
    expect(file.readUInt32LE(24)).toBe(16_000)
    expect(file.readUInt32LE(28)).toBe(32_000)
    expect(file.readUInt16LE(34)).toBe(16)
    expect(file.toString("ascii", 36, 40)).toBe("data")
    expect(file.readUInt32LE(40)).toBe(pcm.length)
    expect(file.subarray(44)).toEqual(pcm)
  })
})
