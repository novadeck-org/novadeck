import { describe, expect, it } from "../test"
import { emptiness } from "./emptiness"

// What the runner says of a new session: its record read to its end with nothing in it, no
// turn, the agent at its idle box.
const fresh = {
  loaded: true,
  records: { state: "read", lines: 0, unread: 0 },
  rest: true,
  turned: false,
} as const

describe("emptiness", () => {
  it("is loading until the record has been read", () => {
    expect(emptiness({ ...fresh, loaded: false, records: { state: "reading" } })).toEqual({
      state: "loading",
    })
  })

  it("is empty only as the runner proved it: read, no turn, the agent idle", () => {
    expect(emptiness(fresh)).toEqual({ state: "empty" })
  })

  it("is empty with a record whose file isn't there yet", () => {
    expect(emptiness({ ...fresh, records: { state: "absent" } })).toEqual({ state: "empty" })
  })

  it("is unproven where the record can't be found or read", () => {
    expect(emptiness({ ...fresh, records: { state: "lost" } })).toEqual({
      state: "unproven",
      reason: "lost",
    })
  })

  it("is unproven where the record holds lines nothing was made of", () => {
    expect(emptiness({ ...fresh, records: { state: "read", lines: 9, unread: 2 } })).toEqual({
      state: "unproven",
      reason: "unread",
    })
  })

  it("is unproven where a turn was seen that left nothing in the record", () => {
    expect(emptiness({ ...fresh, turned: true })).toEqual({ state: "unproven", reason: "turned" })
    expect(emptiness({ ...fresh, records: { state: "absent" }, turned: true })).toEqual({
      state: "unproven",
      reason: "turned",
    })
  })

  it("is unproven where something else is on the agent's screen", () => {
    expect(emptiness({ ...fresh, rest: false })).toEqual({ state: "unproven", reason: "screen" })
  })

  it("waits for the runner to have looked at the screen", () => {
    expect(emptiness({ ...fresh, rest: null })).toEqual({ state: "loading" })
    // A record it can't read is no reason to wait on the screen.
    expect(emptiness({ ...fresh, rest: null, records: { state: "lost" } }).state).toBe("unproven")
  })

  it("is unproven for a conversation counted loaded with no word on its record", () => {
    expect(emptiness({ ...fresh, records: { state: "reading" } })).toEqual({
      state: "unproven",
      reason: "lost",
    })
  })
})
