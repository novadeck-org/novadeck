import { describe, expect, it } from "../test"
import { titleSourceText } from "./title-source"

describe("who a terminal's name is from", () => {
  it("says the person, the agent's terminal, the first prompt or the default", () => {
    expect(titleSourceText({ kind: "person" })).toBe("Named by you")
    expect(titleSourceText({ kind: "agent", by: "t2" })).toBe("Named by the agent in t2")
    expect(titleSourceText({ kind: "fallback" })).toBe("Named after its first prompt")
    expect(titleSourceText({ kind: "default" })).toBe("Default name")
  })
})
