import { describe, expect, it } from "../test.js"
import { restartedTask } from "./resumes.js"

describe("the task a restored worker starts again", () => {
  const command = 'codex "[Novadeck: automatic notice, agent messages waiting, k3f9q2]"'

  it("is the command it was opened with while it is led and no agent session reported there", () => {
    expect(restartedTask({ agents: {}, command }, "moth")).toEqual({ command, nonce: "k3f9q2" })
    // Antigravity started plain, in a folder it didn't trust: its task waits for the ring.
    expect(restartedTask({ agents: {}, command: "agy" }, "moth")).toEqual({
      command: "agy",
      nonce: undefined,
    })
  })

  it("is none once its lead ended, an agent ran there, or its command starts no agent", () => {
    expect(restartedTask({ agents: {}, command }, null)).toBeUndefined()
    expect(restartedTask(undefined, "moth")).toBeUndefined()
    expect(
      restartedTask({ agents: { codex: { sessionId: "t-1", seq: 1 } }, command }, "moth"),
    ).toBeUndefined()
    expect(restartedTask({ agents: {}, command: null }, "moth")).toBeUndefined()
    expect(restartedTask({ agents: {}, command: "npm run dev" }, "moth")).toBeUndefined()
  })
})
