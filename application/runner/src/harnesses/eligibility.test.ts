import { describe, expect, it } from "../test.js"
import { resumeAvailability, type ResumeFacts } from "./eligibility.js"

const facts: ResumeFacts = {
  agent: "claude",
  resumes: true,
  connected: true,
  session: "abc",
  inUse: false,
}

describe("resume availability", () => {
  it("is ready for a connected harness's own session that no other terminal uses", () => {
    expect(resumeAvailability(facts)).toEqual({ state: "ready" })
  })

  it("names why a session cannot resume", () => {
    const reason = (changed: Partial<ResumeFacts>) => {
      const result = resumeAvailability({ ...facts, ...changed })
      return result.state === "unavailable" ? result.reason : undefined
    }
    expect(reason({ connected: false })).toBe("not-connected")
    expect(reason({ resumes: false })).toBe("unsupported")
    expect(reason({ session: undefined })).toBe("no-session")
    expect(reason({ session: "; rm -rf ~" })).toBe("invalid-session")
    expect(reason({ inUse: true })).toBe("in-use")
  })
})
