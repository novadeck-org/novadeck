import { describe as context, describe, expect, it } from "vitest"

import { base64Parts } from "./parts.js"

// Parts of 8 base64 characters: 6 bytes each.
const length = 8

const bytes = (count: number) => Uint8Array.from({ length: count }, (_, at) => at % 256)

/** The bytes a list of parts carries, put back together at their offsets. */
const joined = (parts: ReturnType<typeof base64Parts>, size: number) => {
  const data = new Uint8Array(size)
  for (const part of parts)
    data.set(
      Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0)),
      part.offset,
    )
  return data
}

describe("base64Parts", () => {
  context("with no bytes", () => {
    it("has no parts", () => {
      expect(base64Parts(new Uint8Array(), length)).toEqual([])
    })
  })

  context("with exactly one part's worth", () => {
    it("sends one unpadded part", () => {
      const parts = base64Parts(bytes(6), length)
      expect(parts).toEqual([{ offset: 0, data: btoa("\x00\x01\x02\x03\x04\x05") }])
      expect(parts[0]!.data).toHaveLength(length)
    })
  })

  context("with a whole number of parts", () => {
    it("starts each at its byte offset, with none padded", () => {
      const parts = base64Parts(bytes(18), length)
      expect(parts.map((part) => part.offset)).toEqual([0, 6, 12])
      for (const part of parts) expect(part.data).toHaveLength(length)
      expect(joined(parts, 18)).toEqual(bytes(18))
    })
  })

  context("with a tail", () => {
    it("pads only the last part", () => {
      const parts = base64Parts(bytes(13), length)
      expect(parts.map((part) => part.offset)).toEqual([0, 6, 12])
      expect(parts.map((part) => part.data.endsWith("="))).toEqual([false, false, true])
      expect(joined(parts, 13)).toEqual(bytes(13))
    })
  })

  context("with a part longer than one string conversion", () => {
    it("keeps every byte", () => {
      const data = bytes(3 * 10_000)
      const parts = base64Parts(data, 4 * 10_000)
      expect(parts).toHaveLength(1)
      expect(joined(parts, data.length)).toEqual(data)
    })
  })
})
