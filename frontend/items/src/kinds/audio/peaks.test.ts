import { describe, expect, it } from "../../test"
import { decodePeaks, reduce } from "./peaks"

describe("a recording's peaks", () => {
  it("are reduced to as many bars as there is room for, each the loudest of its share", () => {
    const fine = [0.1, 0.9, 0.2, 0.3, 0.8, 0.1, 0.4, 0.5]
    expect(reduce(fine, 4)).toEqual([0.9, 0.3, 0.8, 0.5])
    expect(reduce(fine, 2)).toEqual([0.9, 0.8])
    expect(reduce(fine, 1)).toEqual([0.9])
  })

  it("are stretched where the bars outnumber them, never leaving a bar empty", () => {
    expect(reduce([0.2, 0.6], 6)).toEqual([0.2, 0.2, 0.2, 0.6, 0.6, 0.6])
    expect(reduce([0.5], 3)).toEqual([0.5, 0.5, 0.5])
  })

  it("come to nothing where the browser can't decode, as the test one can't", async () => {
    expect(await decodePeaks(new ArrayBuffer(8))).toBeUndefined()
  })
})
