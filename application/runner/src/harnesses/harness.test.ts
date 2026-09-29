import { describe, expect, it } from "../test.js"
import { sessionStart } from "./harness.js"
import { harnesses } from "./registry.js"

describe("a SessionStart source", () => {
  it("is a fresh start only for startup", () => {
    expect(sessionStart("startup")).toBe("startup")
  })

  it("is a switch the harness made itself for resume, clear and compact", () => {
    for (const source of ["resume", "clear", "compact"])
      expect(sessionStart(source)).toBe("native-switch")
  })

  it("only observes the conversation when there is none, as from Antigravity", () => {
    expect(sessionStart(undefined)).toBe("conversation-observed")
    expect(harnesses.agy.continuity(undefined)).toBe("conversation-observed")
  })
})

describe("the harness registry", () => {
  it("resumes each harness's session by its own command", () => {
    expect(harnesses.claude.resume?.("s")).toEqual(["claude", "--resume", "s"])
    expect(harnesses.codex.resume?.("s")).toEqual(["codex", "resume", "s"])
    expect(harnesses.agy.resume?.("s")).toEqual(["agy", "--conversation", "s"])
  })

  it("gives only Codex a shim", () => {
    expect(
      Object.values(harnesses)
        .filter((harness) => harness.shims)
        .map(({ id }) => id),
    ).toEqual(["codex"])
  })
})
