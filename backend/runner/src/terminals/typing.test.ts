import type { Request } from "../harnesses/activity.js"
import { describe, expect, it } from "../test.js"
import { requestFacts } from "./typing.js"

describe("a request's facts for its dialog adapter", () => {
  const request: Request = {
    requestId: "r1",
    actor: null,
    toolName: "request_user_input_async",
    kind: "question",
    subject: null,
    choices: [],
    input: { questions: [{ title: "Which color?" }] },
    askedAt: 1,
  }

  it("says what it asks, and where: its hook's directory, else the terminal's", () => {
    expect(requestFacts(request, "/term", "working")).toEqual({
      kind: "question",
      tool: "request_user_input_async",
      input: { questions: [{ title: "Which color?" }] },
      cwd: "/term",
    })
    expect(requestFacts({ ...request, cwd: "/hook" }, "/term", "idle").cwd).toBe("/hook")
    expect(requestFacts({ ...request, answered: [0] }, null, "working").answered).toEqual([0])
  })

  it("says the turn has ended for a request asked without waiting, once no turn runs", () => {
    const detached = { ...request, detached: true as const }
    expect(requestFacts(detached, null, "working").turnEnded).toBeUndefined()
    expect(requestFacts(detached, null, "idle").turnEnded).toBe(true)
    expect(requestFacts(detached, null, undefined).turnEnded).toBe(true)
    // A request that holds its turn ends with it: it is never told so.
    expect(requestFacts(request, null, "idle").turnEnded).toBeUndefined()
  })
})
