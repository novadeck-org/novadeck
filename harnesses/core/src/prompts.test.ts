import { describe, expect, it } from "vitest"

import { doorbell, doorbellLine, doorbellNonce, promptStart, withoutDoorbell } from "./prompts.js"

const base = { agent: "codex", sessionId: "s1", instance: null, startedAt: 10 } as const
const bell = doorbellLine("Ab12")

describe("the doorbell line", () => {
  it("is Novadeck's notice with its nonce", () => {
    expect(bell).toBe("[Novadeck: automatic notice, agent messages waiting, Ab12]")
  })

  it("gives its nonce back from a prompt that is only the line", () => {
    expect(doorbellNonce(`  ${bell}\n`)).toBe("Ab12")
    expect(doorbellNonce(`go on ${bell}`)).toBeUndefined()
    expect(doorbellNonce("[Novadeck: automatic notice, agent messages waiting, a-b]")).toBe(
      undefined,
    )
  })

  it("is found anywhere in a text, and left out of the person's prompt", () => {
    expect(`one ${bell} two ${doorbellLine("Cd34")}`.match(doorbell)).toHaveLength(2)
    expect(withoutDoorbell(`half ${bell}  typed`)).toBe("half typed")
  })
})

describe("the turn a root prompt starts", () => {
  it("is the doorbell's for its line", () => {
    expect(promptStart(base, bell)).toEqual({
      ...base,
      type: "turn-started",
      cause: "doorbell",
      nonce: "Ab12",
    })
  })

  it("is the harness's for a hook's continuation, or where the harness says so", () => {
    expect(promptStart(base, "<hook_prompt>go on</hook_prompt>")).toMatchObject({
      cause: "harness",
    })
    expect(promptStart(base, "x\n<novadeck-messages>…")).toMatchObject({ cause: "harness" })
    expect(promptStart(base, "fix it", true)).toMatchObject({ cause: "harness" })
  })

  it("is the person's, with their text and no doorbell line left in it", () => {
    expect(promptStart({ ...base, turn: "t1" }, `${bell} fix it`)).toEqual({
      ...base,
      turn: "t1",
      type: "turn-started",
      cause: "prompt",
      prompt: "fix it",
    })
    expect(promptStart(base, "  ")).toEqual({ ...base, type: "turn-started", cause: "prompt" })
  })
})
