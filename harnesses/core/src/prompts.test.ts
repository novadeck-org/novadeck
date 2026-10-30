import { describe, expect, it } from "vitest"

import { doorbell, doorbellLine, doorbellNonce } from "./prompts.js"

// What a prompt starts and how a stale line is left out are tested with the harnesses, in
// the runner's harnesses/answers.test.ts; this pins the line itself.
describe("the doorbell line", () => {
  const bell = doorbellLine("Ab12")

  it("is Novadeck's notice with its nonce", () => {
    expect(bell).toBe("[Novadeck: automatic notice, agent messages waiting, Ab12]")
  })

  it("takes only letters and digits as a nonce", () => {
    expect(doorbellNonce(doorbellLine("a-b"))).toBeUndefined()
  })

  it("is found wherever it is in a text, as often as it is there", () => {
    expect(`one ${bell} two ${doorbellLine("Cd34")}`.match(doorbell)).toHaveLength(2)
  })
})
