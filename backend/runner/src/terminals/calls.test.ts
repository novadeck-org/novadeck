import { describe, expect, it } from "vitest"

import { Calls, type CallsHost } from "./calls.js"

const token = "a".repeat(48)
const call = { type: "models", terminalId: "t1", token, request: {} } as const
const claude = [{ id: "opus", efforts: ["low", "max"] }] as const

const calls = (models: CallsHost["models"]) =>
  new Calls(1000, {
    records: () => new Map([["t1", { terminal: { exiting: false }, token }]]),
    models,
  } as unknown as CallsHost)

describe("the models call", () => {
  it("answers each harness's models, none for one that can't be listed", async () => {
    const answer = await calls((agent) =>
      agent === "claude"
        ? Promise.resolve(claude)
        : agent === "codex"
          ? Promise.reject(new Error("unreadable"))
          : Promise.resolve([]),
    ).call(call)
    expect(answer).toEqual({ ok: true, models: { claude, codex: [], agy: [] } })
  })

  it("learns nothing more for a call without the terminal's own token", async () => {
    const unknown = calls(() => Promise.resolve(claude))
    expect(await unknown.call({ ...call, token: "b".repeat(48) })).toEqual({
      ok: false,
      reason: "Novadeck couldn't list the models.",
    })
  })
})
