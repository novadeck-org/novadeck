import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"
import { vi } from "vitest"

import { harnesses } from "../harnesses/registry.js"
import { describe, expect, it } from "../test.js"
import { savedSession } from "./binding/standing.js"
import {
  cancelResume,
  Claims,
  folderFor,
  launchFor,
  restartedTask,
  resumeFolder,
  resumeNote,
  resumeRefusal,
  sessionHeldElsewhere,
  transcriptFor,
  wakeRefusal,
} from "./resumes.js"

describe("the task a restored worker starts again", () => {
  const command = `codex "<novadeck-doorbell from='' ring='k3f9q2'/>"`

  it("reads the nonce of a command saved before the tag as well", () => {
    const old = 'codex "[Novadeck: automatic notice, agent messages waiting, k3f9q2]"'
    expect(restartedTask({ agents: {}, command: old }, "moth")).toEqual({
      command: old,
      nonce: "k3f9q2",
    })
  })

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

  it("resumes with the flags the session was launched with, the model asked for replacing theirs", () => {
    const launch = ["--permission-mode", "plan", "--model", "opus", "--effort", "high"]
    expect(claims().check("t1", "claude", "s-1", true, undefined, launch)).toEqual({
      ok: true,
      argv: ["claude", "--effort", "high", "--resume", "s-1"],
      key: "claude:s-1",
    })
    expect(claims().check("t1", "claude", "s-1", true, { model: "sonnet" }, launch)).toMatchObject({
      argv: ["claude", "--model", "sonnet", "--effort", "high", "--resume", "s-1"],
    })
  })

  it("gives its harness the transcript the session bound with, which the others leave out of their words", () => {
    const transcript = "/home/me/.pi/agent/sessions/--p--/2026_s-1.jsonl"
    const resume = vi.spyOn(harnesses.pi.launch, "resume")
    // pi may take the file itself; every other harness's words are the same with it or without.
    claims().check("t1", "pi", "s-1", true, undefined, undefined, transcript)
    expect(resume).toHaveBeenCalledWith("s-1", undefined, undefined, transcript)
    resume.mockRestore()
    for (const agent of ["claude", "codex", "agy", "opencode"] as const)
      expect(claims().check("t1", agent, "s-1", true, undefined, undefined, transcript)).toEqual(
        claims().check("t1", agent, "s-1", true),
      )
  })

  it("finds the transcript a session bound with in any row, the newest report first", () => {
    const rows = [
      { agents: { pi: { sessionId: "s-1", seq: 1, transcript: "/a/old.jsonl" } } },
      { agents: { pi: { sessionId: "s-1", seq: 5, transcript: "/a/new.jsonl" } } },
      { agents: { pi: { sessionId: "s-2", seq: 9, transcript: "/a/other.jsonl" } } },
      { agents: { pi: { sessionId: "s-3", seq: 5 } } },
    ]
    expect(transcriptFor(rows, "pi", "s-1")).toBe("/a/new.jsonl")
    expect(transcriptFor(rows, "pi", "s-3")).toBeUndefined()
    expect(transcriptFor(rows, "claude", "s-1")).toBeUndefined()
  })

  it("finds the flags a session was launched with in any row, the newest report first", () => {
    const rows = [
      { agents: { claude: { sessionId: "s-1", seq: 1, launch: ["--effort", "low"] } } },
      { agents: { claude: { sessionId: "s-2", seq: 9, launch: ["--effort", "max"] } } },
      { agents: { claude: { sessionId: "s-1", seq: 5, launch: ["--effort", "high"] } } },
      { agents: { codex: { sessionId: "s-1", seq: 7, launch: ["--sandbox", "read-only"] } } },
      { agents: { claude: { sessionId: "s-3", seq: 5 } } },
    ]
    expect(launchFor(rows, "claude", "s-1")).toEqual(["--effort", "high"])
    expect(launchFor(rows, "codex", "s-1")).toEqual(["--sandbox", "read-only"])
    expect(launchFor(rows, "claude", "s-3")).toBeUndefined()
    expect(launchFor(rows, "agy", "s-1")).toBeUndefined()
  })

  it("judges a restored terminal's resume with the flags its saved row kept", () => {
    const saved = {
      agents: {
        codex: {
          sessionId: "s-1",
          seq: 1,
          launch: ["--sandbox", "read-only", "--dangerously-bypass-hook-trust"],
        },
      },
    }
    expect(claims().judge({ id: "t1", resume: "codex" }, saved, true)).toMatchObject({
      ok: true,
      argv: [
        "codex",
        "resume",
        "--dangerously-bypass-hook-trust",
        "-c",
        "tui.resume_cwd=session",
        "s-1",
      ],
    })
    const old = { agents: { codex: { sessionId: "s-1", seq: 1 } } }
    expect(claims().judge({ id: "t1", resume: "codex" }, old, true)).toMatchObject({
      argv: ["codex", "resume", "-c", "tui.resume_cwd=session", "s-1"],
    })
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

  it("resumes Novadeck's own pi's session on its own word, with no connection of the person's", () => {
    const own = "/data/bundled/pi/agent/sessions/--tour--/2026_s-1.jsonl"
    const mine = new Claims({
      boundElsewhere: () => false,
      nova: {
        owns: (agent: AgentName, transcript: string | undefined) =>
          agent === "pi" && transcript === own,
        starts: () => true,
        followSwitch: () => () => {},
      },
    })
    expect(
      mine.check("t1", "pi", "s-1", false, undefined, ["--model", "novadeck/gpt-6-luna"], own),
    ).toEqual({
      ok: true,
      // pi's session keeps its own model, which a resume doesn't name again.
      argv: ["novadeck-pi", "--session", own],
      key: "pi:s-1",
    })
    // The person's own pi's session is theirs, and needs their connection.
    const theirs = "/home/me/.pi/agent/sessions/--p--/2026_s-2.jsonl"
    expect(mine.check("t1", "pi", "s-2", false, undefined, undefined, theirs)).toEqual({
      ok: false,
      reason: "not-connected",
    })
    expect(mine.check("t1", "pi", "s-2", true, undefined, undefined, theirs)).toMatchObject({
      argv: ["pi", "--session", theirs],
    })
    // Taken by another terminal, it is in use as any session.
    mine.claim("pi:s-1", "other")
    const taken = mine.check("t1", "pi", "s-1", false, undefined, undefined, own)
    expect(taken).toEqual({ ok: false, reason: "in-use", nova: true })
    // Said of Nova by its name, the person's pi by Pi's.
    expect(resumeNote(taken, "pi", false)).toBe(
      "Nova was running here, but wasn't resumed: that Nova session is already open in another terminal.",
    )
    expect(resumeNote({ ok: false, reason: "in-use" }, "pi", false)).toBe(
      "Pi was running here, but wasn't resumed: that Pi session is already open in another terminal.",
    )
    expect(wakeRefusal("pi", "in-use", true)).toBe(
      "Nova was asleep there and could not be woken: that Nova session is open in another terminal.",
    )
    expect(resumeRefusal("pi", "conversation-gone", false, true)).toBe(
      "That Nova conversation is gone: Nova no longer has it.",
    )
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

describe("the folder a resume starts in", () => {
  const root = "/home/x/.novadeck/worktrees"
  const saved = {
    agents: {
      claude: { sessionId: "c-1", seq: 1, cwd: "/home/x/project" },
      agy: { sessionId: "a-1", seq: 1, cwd: root },
      codex: { sessionId: "x-1", seq: 1 },
    },
  }

  it("is where the resumed session bound", () => {
    expect(resumeFolder(saved, { resume: "claude" }, root)).toBe("/home/x/project")
    expect(resumeFolder(saved, { resume: "claude" }, undefined)).toBe("/home/x/project")
  })

  it("is none for no resume, a command of its own, a session with no folder, or the bare worktrees folder", () => {
    expect(resumeFolder(saved, {}, root)).toBeUndefined()
    expect(resumeFolder(saved, { resume: "claude", command: "claude" }, root)).toBeUndefined()
    expect(resumeFolder(saved, { resume: "codex" }, root)).toBeUndefined()
    expect(resumeFolder({ agents: {} }, { resume: "claude" }, root)).toBeUndefined()
    expect(resumeFolder(undefined, { resume: "claude" }, root)).toBeUndefined()
    // An Antigravity session saved as the folder of agents' worktrees, where none works.
    expect(resumeFolder(saved, { resume: "agy" }, root)).toBeUndefined()
  })
})

describe("the folder an agent's resume of a past session starts in", () => {
  const root = "/home/x/.novadeck/worktrees"
  const report = (sessionId: string, seq: number, cwd?: string) => ({
    agents: { claude: { sessionId, seq, ...(cwd !== undefined && { cwd }) } },
  })

  it("is where the session bound, as its newest report keeps it", () => {
    const rows = [report("s", 1, "/old"), report("s", 3, "/new"), report("t", 9, "/other")]
    expect(folderFor(rows, "claude", "s", root)).toBe("/new")
    // A newer one that names none, as older reports didn't, leaves the folder one names.
    expect(folderFor([report("s", 1, "/old"), report("s", 3)], "claude", "s", root)).toBe("/old")
  })

  it("is none for a session no row has, one with no folder, or the bare worktrees folder", () => {
    expect(folderFor([report("t", 1, "/a")], "claude", "s", root)).toBeUndefined()
    expect(folderFor([report("s", 1)], "claude", "s", root)).toBeUndefined()
    expect(folderFor([report("s", 1, root)], "claude", "s", root)).toBeUndefined()
    expect(folderFor([report("s", 1, "/a")], "codex", "s", root)).toBeUndefined()
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

describe("cancelling a resume", () => {
  it("removes the command, keeping the claim its standing reports are read through", () => {
    const file = join(mkdtempSync(join(tmpdir(), "resume-")), "cmd")
    writeFileSync(file, "claude --resume c")
    const record = { resumeFile: file, resumeClaim: "claude:c" as string | undefined }
    expect(cancelResume(record)).toBe(true)
    expect(record.resumeClaim).toBe("claude:c")
    expect(cancelResume(record)).toBe(false)
  })

  it("leaves the session's standing reports readable, so its done mark stands", () => {
    const file = join(mkdtempSync(join(tmpdir(), "resume-")), "cmd")
    writeFileSync(file, "claude --resume c")
    const record = { resumeFile: file, resumeClaim: "claude:c", bound: null }
    cancelResume(record)
    expect(savedSession(record)).toEqual({ agent: "claude", sessionId: "c" })
  })
})
