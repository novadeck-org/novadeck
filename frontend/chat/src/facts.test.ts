import { span } from "./facts"
import { describe, expect, it } from "./test"

describe("how long a fact says", () => {
  it("counts seconds, then minutes to the second, then hours to the minute", () => {
    expect(span(0)).toBe("0s")
    expect(span(38_900)).toBe("38s")
    expect(span(65_000)).toBe("1m 05s")
    expect(span(400_000)).toBe("6m 40s")
    expect(span(3_900_000)).toBe("1h 05m")
  })

  it("never goes below nothing", () => {
    expect(span(-3000)).toBe("0s")
  })
})
