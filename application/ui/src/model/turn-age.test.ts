import { describe, expect, it } from "../test"
import { nextTurnAge, turnAge } from "./turn-age"
import type { TerminalMetadata } from "./types"

const minute = 60_000

const terminal = (at?: number): TerminalMetadata => ({
  id: "1",
  name: "Agent",
  directory: "~/work",
  command: "",
  process: "claude",
  state: "running",
  agent: {
    working: false,
    ...(at === undefined ? {} : { lastTurn: { outcome: "completed", at } }),
  },
})

describe("how long ago an agent's turn ended", () => {
  it("counts minutes, then hours, then days", () => {
    expect(turnAge(terminal(0), 30_000)).toBe("now")
    expect(turnAge(terminal(0), 4 * minute + 59_000)).toBe("4m")
    expect(turnAge(terminal(0), 59 * minute)).toBe("59m")
    expect(turnAge(terminal(0), 2 * 60 * minute + 5 * minute)).toBe("2h")
    expect(turnAge(terminal(0), 3 * 24 * 60 * minute)).toBe("3d")
  })

  it("reads an end its runner's clock puts ahead as now", () => {
    expect(turnAge(terminal(10_000), 0)).toBe("now")
  })

  it("says nothing where its harness doesn't tell when", () => {
    expect(turnAge(terminal())).toBeUndefined()
    expect(nextTurnAge(terminal())).toBeUndefined()
    expect(turnAge({ ...terminal(0), state: "idle" }, minute)).toBeUndefined()
  })

  it("changes next at the following minute, hour or day", () => {
    expect(nextTurnAge(terminal(0), 30_000)).toBe(minute)
    expect(nextTurnAge(terminal(0), 4 * minute + 1)).toBe(5 * minute)
    expect(nextTurnAge(terminal(0), 61 * minute)).toBe(120 * minute)
  })
})
