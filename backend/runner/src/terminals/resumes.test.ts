import { describe, expect, it } from "../test.js"
import {
  Claims,
  restartedTask,
  resumeNote,
  resumeRefusal,
  sessionHeldElsewhere,
} from "./resumes.js"

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

describe("the session a restore asks to resume", () => {
  const claims = new Claims({ boundElsewhere: () => false })
  const saved = { agents: { claude: { sessionId: "s-1", seq: 1 } } }

  it("is judged from the saved row, and not at all for a command given or an agent not asked", () => {
    const ask = { id: "t1", resume: "claude" as const }
    expect(claims.judge(ask, saved, true)).toMatchObject({
      ok: true,
      key: "claude:s-1",
    })
    expect(claims.judge({ id: "t1" }, saved, true)).toBeUndefined()
    expect(claims.judge({ ...ask, command: "ls" }, saved, true)).toBeUndefined()
    expect(claims.judge(ask, saved, false)).toEqual({
      ok: false,
      reason: "not-connected",
    })
    expect(claims.judge(ask, { agents: {} }, true)).toEqual({
      ok: false,
      reason: "no-session",
    })
    expect(claims.judge(ask, undefined, true)).toEqual({
      ok: false,
      reason: "no-session",
    })
  })

  it("says to the person why an agent that ran was not resumed, and nothing when it was", () => {
    const ask = { id: "t1", resume: "codex" as const }
    expect(resumeNote(claims.judge(ask, saved, true), "codex", false)).toBe(
      "Codex was running here, but wasn't resumed: Novadeck has no Codex session saved for this terminal.",
    )
    const claude = { ...ask, resume: "claude" as const }
    expect(resumeNote(claims.judge(claude, saved, false), "claude", false)).toContain(
      "Novadeck isn't connected to Claude Code",
    )
    expect(resumeNote(claims.judge(claude, saved, true), "claude", true)).toBeUndefined()
    // Judged fit, but the shell took no command to resume it.
    expect(resumeNote(claims.judge(claude, saved, true), "claude", false)).toContain(
      "this shell can't run the command",
    )
    expect(resumeNote(undefined, undefined, false)).toBeUndefined()
  })
})

describe("a session another terminal holds", () => {
  const other = (id: string, held: { bound?: string; root?: string }) =>
    ({
      summary: { id },
      bound: held.bound ? { binding: { agent: "agy", sessionId: held.bound } } : null,
      root: held.root ? { agent: "agy", sessionId: held.root } : null,
    }) as never

  it("is held by a binding, or by the root conversation a status line names", () => {
    const records = [other("b", { bound: "first", root: "convo" })]
    expect(sessionHeldElsewhere(records, "a", "agy", "first")).toBe(true)
    expect(sessionHeldElsewhere(records, "a", "agy", "convo")).toBe(true)
    expect(sessionHeldElsewhere(records, "a", "agy", "else")).toBe(false)
    expect(sessionHeldElsewhere(records, "a", "claude", "convo")).toBe(false)
  })

  it("is not held by the terminal itself", () => {
    expect(sessionHeldElsewhere([other("a", { root: "convo" })], "a", "agy", "convo")).toBe(false)
  })
})
