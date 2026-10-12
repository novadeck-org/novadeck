import { describe, expect, it } from "../test.js"
import { parseVmStat } from "./memory.js"

const output = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            400000.
Pages inactive:                          200000.
Pages speculative:                         5000.
Pages wired down:                         90000.
Pages purgeable:                          15000.
`

describe("reading vm_stat", () => {
  it("adds free, inactive, speculative and purgeable pages, by the page size", () => {
    expect(parseVmStat(output)).toBe((10000 + 200000 + 5000 + 15000) * 16384)
  })

  it("is undefined for output it can't read", () => {
    expect(parseVmStat("")).toBeUndefined()
    expect(parseVmStat("Pages free: 10.")).toBeUndefined()
  })
})
