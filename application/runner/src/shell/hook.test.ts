import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { hookScript } from "./hook.js"
import { listenForReports, type Report } from "./reports.js"

type Fixture = {
  endpoint: string
  reports: Report[]
  /** Runs the hook as an agent would, and resolves once it exits. */
  hook: (agent: string, payload: unknown, env?: NodeJS.ProcessEnv) => Promise<number | null>
}

const terminalId = "00000000-0000-4000-8000-000000000001"
// Shaped like a runner's token: 48 hex digits.
const token = "0123456789abcdef".repeat(3)
const session = "11111111-2222-4333-8444-555555555555"

const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-hook-"))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    const script = join(directory, "hook.mjs")
    writeFileSync(script, hookScript)
    const reports: Report[] = []
    const listening = await listenForReports((report) => reports.push(report))
    resources.defer(() => listening.close())
    const hook: Fixture["hook"] = (agent, payload, env = {}) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [script, agent], {
          env: {
            ...process.env,
            NOVADECK_TERMINAL_ID: terminalId,
            NOVADECK_REPORT: listening.endpoint,
            NOVADECK_REPORT_TOKEN: token,
            CURSOR_VERSION: "",
            CODEX_THREAD_ID: "",
            ...env,
          },
          stdio: ["pipe", "pipe", "inherit"],
        })
        let printed = ""
        child.stdout.on("data", (data: Buffer) => (printed += data.toString()))
        child.on("exit", (code) => {
          // Claude Code shows a SessionStart hook's output to the model; Antigravity
          // reads it as JSON.
          resolve(printed === (agent === "agy" ? "{}\n" : "") ? code : -1)
        })
        child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload))
      })
    await use({ endpoint: listening.endpoint, reports, hook })
  },
})

const start = (fields: object = {}) => ({
  hook_event_name: "SessionStart",
  source: "startup",
  session_id: session,
  cwd: "/work",
  ...fields,
})

describe("agent hook", () => {
  it("reports the session to its terminal with its token", async ({ fixture }) => {
    expect(await fixture.hook("claude", start())).toBe(0)
    expect(fixture.reports).toEqual([
      expect.objectContaining({
        terminalId,
        token,
        agent: "claude",
        sessionId: session,
        seq: expect.any(Number),
      }),
    ])
  })

  it("orders reports by when each hook started", async ({ fixture }) => {
    await fixture.hook("claude", start())
    await fixture.hook("claude", start({ source: "clear", session_id: "second" }))
    const [first, second] = fixture.reports
    expect(second!.seq).toBeGreaterThan(first!.seq)
  })

  it("ignores Claude Code subagents and Claude Code inside Cursor", async ({ fixture }) => {
    await fixture.hook("claude", start({ agent_id: "sub" }))
    await fixture.hook("claude", start({ cursor_version: "1.0" }))
    await fixture.hook("claude", start(), { CURSOR_VERSION: "1.0" })
    expect(fixture.reports).toEqual([])
  })

  it("ignores a Codex started by another Codex", async ({ fixture }) => {
    await fixture.hook("codex", start({ model: "gpt" }), { CODEX_THREAD_ID: "another" })
    expect(fixture.reports).toEqual([])
    await fixture.hook("codex", start({ model: "gpt" }), { CODEX_THREAD_ID: session })
    expect(fixture.reports).toHaveLength(1)
  })

  it("exits quietly outside NovaDeck's terminals and on anything malformed", async ({
    fixture,
  }) => {
    expect(await fixture.hook("claude", start(), { NOVADECK_TERMINAL_ID: "" })).toBe(0)
    expect(await fixture.hook("claude", "not json")).toBe(0)
    expect(await fixture.hook("claude", start({ session_id: "../../etc" }))).toBe(0)
    expect(await fixture.hook("claude", start({ hook_event_name: "Stop" }))).toBe(0)
    expect(await fixture.hook("gemini", start())).toBe(0)
    expect(fixture.reports).toEqual([])
  })

  it("reads Antigravity's conversation and workspace, and answers it with JSON", async ({
    fixture,
  }) => {
    const workspace = process.platform === "win32" ? "C:\\work" : "/work"
    const payload = { conversationId: session, workspacePaths: [workspace], modelName: "auto" }
    expect(await fixture.hook("agy", payload)).toBe(0)
    expect(fixture.reports).toEqual([
      expect.objectContaining({ agent: "agy", sessionId: session, cwd: workspace }),
    ])
    expect(await fixture.hook("agy", payload, { NOVADECK_TERMINAL_ID: "" })).toBe(0)
  })

  it("gives up without blocking the agent when NovaDeck is gone", async ({ fixture }) => {
    const code = await fixture.hook("claude", start(), {
      NOVADECK_REPORT: join(tmpdir(), "novadeck-missing", "reports.sock"),
    })
    expect(code).toBe(0)
  })
})
