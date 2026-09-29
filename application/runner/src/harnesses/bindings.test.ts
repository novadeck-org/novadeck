import { describe, expect, it } from "../test.js"
import { observe, type Facts, type Sessions } from "./bindings.js"
import type { SessionObserved } from "./events.js"

const idle: Sessions = { sessions: {}, binding: null, cwd: "/home" }
const facts: Facts = {
  promptedAt: 1_000,
  shellInForeground: false,
  submitted: true,
  connected: true,
  platform: "linux",
}
const seen = (fields: Partial<SessionObserved> = {}): SessionObserved => ({
  type: "session-observed",
  agent: "claude",
  sessionId: "a",
  evidence: "startup",
  startedAt: 2_000,
  ...fields,
})
const running: Sessions = {
  sessions: { claude: { sessionId: "a", seq: 2_000 } },
  binding: { agent: "claude", sessionId: "a" },
  cwd: "/work",
}

describe("observing a harness session", () => {
  it("binds the session now holding the foreground, in its directory", () => {
    expect(observe(idle, seen({ cwd: "/work" }), facts)).toEqual({
      sessions: { claude: { sessionId: "a", seq: 2_000 } },
      binding: { agent: "claude", sessionId: "a" },
      cwd: "/work",
    })
  })

  it("keeps a session from a hook started before the prompt without binding it", () => {
    expect(observe(idle, seen({ startedAt: 500, cwd: "/work" }), facts)).toEqual({
      sessions: { claude: { sessionId: "a", seq: 500 } },
      binding: null,
      cwd: "/home",
    })
  })

  it("refuses an observation older than the one it has", () => {
    const state = { ...idle, sessions: { claude: { sessionId: "b", seq: 3_000 } } }
    expect(observe(state, seen({ evidence: "native-switch" }), facts)).toBeUndefined()
  })

  it("refuses an observation while the shell itself holds the foreground", () => {
    expect(observe(idle, seen(), { ...facts, shellInForeground: true })).toBeUndefined()
  })

  it("refuses, on Windows, an observation before any line was entered since the prompt", () => {
    const windows = { ...facts, platform: "win32" as const, shellInForeground: undefined }
    expect(observe(idle, seen(), { ...windows, submitted: false })).toBeUndefined()
    expect(observe(idle, seen(), windows)?.binding).toEqual({ agent: "claude", sessionId: "a" })
  })

  it("ignores a disconnected harness, whose hook may still run", () => {
    expect(observe(idle, seen(), { ...facts, connected: false })).toBeUndefined()
  })

  it("refuses a nested fresh session while another holds the foreground", () => {
    const nested = { sessionId: "n", startedAt: 3_000 }
    expect(observe(running, seen(nested), facts)).toBeUndefined()
    expect(observe(running, seen({ ...nested, agent: "codex" }), facts)).toBeUndefined()
  })

  it("takes a switch the bound harness announced itself", () => {
    expect(
      observe(running, seen({ sessionId: "c", startedAt: 3_000, evidence: "native-switch" }), facts)
        ?.binding,
    ).toEqual({ agent: "claude", sessionId: "c" })
  })

  it("refuses a switch announced by another harness than the bound one", () => {
    const codex = { agent: "codex" as const, sessionId: "c", startedAt: 3_000 }
    expect(observe(running, seen({ ...codex, evidence: "native-switch" }), facts)).toBeUndefined()
    expect(
      observe(running, seen({ ...codex, evidence: "conversation-observed" }), facts),
    ).toBeUndefined()
  })

  it("takes the next conversation the bound harness observes, as Antigravity reports it", () => {
    const agy: Sessions = {
      sessions: { agy: { sessionId: "one", seq: 2_000 } },
      binding: { agent: "agy", sessionId: "one" },
      cwd: "/",
    }
    const next = seen({
      agent: "agy",
      sessionId: "two",
      startedAt: 3_000,
      evidence: "conversation-observed",
    })
    expect(observe(agy, next, facts)).toMatchObject({
      sessions: { agy: { sessionId: "two", seq: 3_000 } },
      binding: { agent: "agy", sessionId: "two" },
    })
  })

  it("refreshes the bound session's directory when it reports again", () => {
    expect(observe(running, seen({ startedAt: 3_000, cwd: "/elsewhere" }), facts)?.cwd).toBe(
      "/elsewhere",
    )
  })
})
