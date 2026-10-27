import { describe, expect, it } from "../test.js"
import { Claims, restartedTask, resumeRefusal } from "./resumes.js"

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

describe("the session an agent asks to resume in a new terminal", () => {
  const claims = (bound: string[] = []) =>
    new Claims({
      boundElsewhere: (_terminal, agent, session) => bound.includes(`${agent}:${session}`),
    })

  it("resumes in each harness with the model and effort, in the place its CLI takes them", () => {
    const choice = { model: "m1", effort: "high" as const }
    expect(claims().check("", "claude", "s-1", true, choice)).toEqual({
      ok: true,
      argv: ["claude", "--model", "m1", "--effort", "high", "--resume", "s-1"],
      key: "claude:s-1",
    })
    expect(claims().check("", "codex", "s-1", true, choice)).toMatchObject({
      ok: true,
      argv: expect.arrayContaining(["codex", "resume", "--model", "m1", "s-1"]),
    })
    expect(claims().check("", "agy", "s-1", true)).toEqual({
      ok: true,
      argv: ["agy", "--conversation", "s-1"],
      key: "agy:s-1",
    })
  })

  it("is refused for a disconnected agent, a session another terminal runs or was given", () => {
    expect(claims().check("", "claude", "s-1", false)).toEqual({
      ok: false,
      reason: "not-connected",
    })
    expect(claims(["codex:s-1"]).check("", "codex", "s-1", true)).toEqual({
      ok: false,
      reason: "in-use",
    })
    const given = claims()
    given.claim("claude:s-1", "other")
    expect(given.check("", "claude", "s-1", true)).toEqual({ ok: false, reason: "in-use" })
    // The terminal that has it may ask again; another session is free.
    expect(given.check("other", "claude", "s-1", true)).toMatchObject({ ok: true })
    expect(given.check("", "claude", "s-2", true)).toMatchObject({ ok: true })
    // Until that terminal closes.
    given.release("other")
    expect(given.check("", "claude", "s-1", true)).toMatchObject({ ok: true })
  })

  it("is judged again as the terminal is created, and claimed only then", () => {
    const run = claims()
    const resume = { agent: "claude" as const, session: "s-1" }
    expect(run.recheck("t-1", undefined)).toBeUndefined()
    expect(run.recheck("t-1", resume)).toBe("claude:s-1")
    run.claim("claude:s-1", "t-1")
    // Another terminal, created for the same session meanwhile, is refused.
    expect(() => run.recheck("t-2", resume)).toThrow(
      expect.objectContaining({ code: "CONFLICT", message: resumeRefusal("claude", "in-use") }),
    )
  })

  it("says why in a sentence for the agent", () => {
    expect(resumeRefusal("codex", "in-use")).toContain("already open in a terminal")
    expect(resumeRefusal("agy", "unsupported")).toBe(
      "Antigravity can't resume a session by its id here.",
    )
  })
})
