import { describe, expect, it } from "../../test"
import { durationsIn, seconds } from "./durations.ts"

describe("a test run's duration", () => {
  it.each([
    ["12.90s (tests 70%)", 12.9],
    ["706ms", 0.706],
    ["4m 53s", 293],
    ["2m", 120],
  ])("reads %j as %d seconds", (text, value) => {
    expect(seconds(text)).toBe(value)
  })

  it("reads each package's line, the repository's unprefixed, adding up a package's shards", () => {
    const log = [
      "2026-11-10T11:17:53.75Z \u001b[2m   Duration \u001b[22m 12.90s\u001b[2m (tests 70%)\u001b[22m",
      "2026-11-10T11:18:05.19Z @novadeck/ui:test: \u001b[2m   Duration \u001b[22m 6.60s",
      "2026-11-10T11:20:05.19Z @novadeck/ui:test: \u001b[2m   Duration \u001b[22m 1m 3s",
      "2026-11-10T11:20:06.00Z @novadeck/ui:test:  Test Files  12 passed (12)",
    ].join("\n")
    expect(Object.fromEntries(durationsIn(log))).toEqual({ "//": 12.9, "@novadeck/ui": 69.6 })
  })
})
