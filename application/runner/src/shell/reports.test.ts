import { connect } from "node:net"

import { describe, expect, it } from "../test.js"
import {
  acceptReport,
  listenForReports,
  type AgentState,
  type Report,
  type ReportFacts,
} from "./reports.js"

const idle: AgentState = { agents: {}, active: null, cwd: "/home" }
const facts: ReportFacts = {
  promptedAt: 1_000,
  shellInForeground: false,
  submitted: true,
  platform: "linux",
}
const report = (fields: Partial<Parameters<typeof acceptReport>[1]> = {}) => ({
  agent: "claude" as const,
  sessionId: "a",
  seq: 2_000,
  ...fields,
})

describe("accepting an agent's report", () => {
  it("records the session of the agent now holding the foreground, in its directory", () => {
    expect(acceptReport(idle, report({ cwd: "/work", source: "startup" }), facts)).toEqual({
      agents: { claude: { sessionId: "a", seq: 2_000 } },
      active: "claude",
      cwd: "/work",
    })
  })

  it("keeps an earlier report's session without taking the foreground", () => {
    expect(acceptReport(idle, report({ seq: 500, cwd: "/work" }), facts)).toEqual({
      agents: { claude: { sessionId: "a", seq: 500 } },
      active: null,
      cwd: "/home",
    })
  })

  it("refuses a report older than the one it has", () => {
    const state = { ...idle, agents: { claude: { sessionId: "b", seq: 3_000 } } }
    expect(acceptReport(state, report({ source: "clear" }), facts)).toBeUndefined()
  })

  it("refuses a report while the shell itself holds the foreground", () => {
    expect(acceptReport(idle, report(), { ...facts, shellInForeground: true })).toBeUndefined()
  })

  it("refuses, on Windows, a report before any line was entered since the prompt", () => {
    const windows = { ...facts, platform: "win32" as const, shellInForeground: undefined }
    expect(acceptReport(idle, report(), { ...windows, submitted: false })).toBeUndefined()
    expect(acceptReport(idle, report(), windows)).toMatchObject({ active: "claude" })
  })

  const running: AgentState = {
    agents: { claude: { sessionId: "a", seq: 2_000 } },
    active: "claude",
    cwd: "/work",
  }

  it("refuses a nested agent's new session while another holds the foreground", () => {
    const nested = { sessionId: "n", seq: 3_000, source: "startup" }
    expect(acceptReport(running, report(nested), facts)).toBeUndefined()
    expect(acceptReport(running, report({ ...nested, agent: "codex" }), facts)).toBeUndefined()
  })

  it("takes a session switch of the agent in the foreground", () => {
    for (const source of ["clear", "resume", "compact"])
      expect(
        acceptReport(running, report({ sessionId: "c", seq: 3_000, source }), facts)?.agents.claude,
      ).toEqual({ sessionId: "c", seq: 3_000 })
  })

  it("takes Antigravity's next conversation, reported without a source", () => {
    const agy: AgentState = {
      agents: { agy: { sessionId: "one", seq: 2_000 } },
      active: "agy",
      cwd: "/",
    }
    expect(
      acceptReport(agy, report({ agent: "agy", sessionId: "two", seq: 3_000 }), facts)?.agents.agy,
    ).toEqual({ sessionId: "two", seq: 3_000 })
  })
})

const send = (endpoint: string, line: string) =>
  new Promise<void>((resolve) => {
    const socket = connect(endpoint)
    socket.on("error", () => resolve())
    socket.on("close", () => resolve())
    socket.end(`${line}\n`)
  })

describe("the report endpoint", () => {
  it("takes only well-formed reports carrying a runner token", async ({ resources }) => {
    const received: Report[] = []
    const reports = await listenForReports((accepted) => received.push(accepted))
    resources.defer(() => reports.close())
    const base = { terminalId: "t", agent: "claude", sessionId: "a", seq: 1 }
    const token = "0123456789abcdef".repeat(3)
    // A token as long as a runner's, in characters but not in bytes, and others.
    const bad = ["ż".repeat(48), "short", token.toUpperCase(), 42]
    await Promise.all(
      bad.map((wrong) => send(reports.endpoint, JSON.stringify({ ...base, token: wrong }))),
    )
    await send(reports.endpoint, "not json")
    await send(reports.endpoint, JSON.stringify({ ...base, token }))
    expect(received).toEqual([{ ...base, token }])
  })
})
