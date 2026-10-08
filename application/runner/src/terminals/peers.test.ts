import type { Request } from "../harnesses/activity.js"
import { describe, expect, it } from "../test.js"
import { waitingOf } from "./peers.js"

const request = (fields: Partial<Request>): Request => ({
  requestId: "r-1",
  actor: null,
  toolName: "Bash",
  kind: "permission",
  subject: null,
  choices: [],
  askedAt: 0,
  ...fields,
})

const subject = (fields: Partial<Request>) => waitingOf({ pending: [request(fields)] })?.subject

describe("what peers learn of a request waiting on the person", () => {
  it("is the oldest, with how many wait after it", () => {
    expect(waitingOf({ pending: [] })).toBeNull()
    expect(waitingOf(null)).toBeNull()
    expect(
      waitingOf({
        pending: [request({ subject: "src/a.ts", toolName: "Edit" }), request({}), request({})],
      }),
    ).toEqual({ kind: "permission", tool: "Edit", subject: null, more: 2 })
  })

  it("never shows a permission's subject, whatever it looks like", () => {
    for (const text of [
      "curl -H 'Authorization: Bearer abc' x",
      "https://example.com/?token=abc",
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "token.txt",
      "/etc/shadow",
      "src/a.ts",
    ])
      expect(subject({ subject: text, toolName: "Write" })).toBeNull()
  })

  it("shows a question's or a plan's subject as it is", () => {
    expect(subject({ kind: "question", subject: "Which database?" })).toBe("Which database?")
    expect(subject({ kind: "plan", subject: "plan.md" })).toBe("plan.md")
  })
})
