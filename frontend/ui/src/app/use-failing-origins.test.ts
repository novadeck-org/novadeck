import { describe, expect, it } from "../test"
import { longFailing } from "./use-failing-origins"

const hour = 60 * 60_000
const now = 100 * hour

describe("which failing origins the footer tells", () => {
  it("only those failing an hour or more, as the runner's own fetches retry a passing blip", () => {
    const long = { repository: "novadeck", said: "Could not resolve host", since: now - 2 * hour }
    const young = { repository: "web", said: "timeout", since: now - 59 * 60_000 }
    expect(longFailing([long, young], now)).toEqual([long])
    expect(longFailing([young], now)).toEqual([])
  })
})
