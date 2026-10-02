import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it as base } from "../test.js"
import { hookScript } from "./hook.js"
import {
  listenForReports,
  unanswered,
  unheard,
  type Ack,
  type HookAnswer,
  type Report,
} from "./reports.js"

type Fixture = {
  endpoint: string
  /** The hook script, as written. */
  script: string
  reports: Report[]
  /** The deadline each ask came with, by its report's event. */
  deadlines: { event: string; seq: number; deadline: number }[]
  /** What the runner answers an ask with; unheard unless a test says otherwise. */
  answer: { current: HookAnswer }
  acks: Ack[]
  /** Runs the hook as an agent would for `event`, and resolves with what it printed. */
  run: (agent: string, payload: unknown, env: NodeJS.ProcessEnv, event: string) => Promise<string>
  /** Runs the hook as an agent would for `event`, and resolves once it exits. */
  hook: (
    agent: string,
    payload: unknown,
    env?: NodeJS.ProcessEnv,
    event?: string,
  ) => Promise<number | null>
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
    const deadlines: Fixture["deadlines"] = []
    const answer = { current: unheard }
    const acks: Ack[] = []
    const listening = await listenForReports({
      report: (report) => reports.push(report),
      ask: (report, deadline) => {
        reports.push(report)
        deadlines.push({ event: report.event, seq: report.seq, deadline })
        return Promise.resolve(answer.current)
      },
      ack: (ack) => acks.push(ack),
      call: () => Promise.resolve(unanswered),
    })
    resources.defer(() => listening.close())
    const hook: Fixture["hook"] = (agent, payload, env = {}, event) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [script, agent, ...(event ? [event] : [])], {
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
          // Claude Code shows some hooks' output to the model; Antigravity reads it as JSON,
          // and denies a tool whose PreToolUse answer does not say "ask".
          const quiet = event === "PreToolUse" ? '{"decision":"ask"}\n' : "{}\n"
          resolve(printed === (agent === "agy" ? quiet : "") ? code : -1)
        })
        child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload))
      })
    const run: Fixture["run"] = (agent, payload, env, event) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [script, agent, event], {
          env: {
            ...process.env,
            NOVADECK_TERMINAL_ID: terminalId,
            NOVADECK_REPORT: listening.endpoint,
            NOVADECK_REPORT_TOKEN: token,
            ...env,
          },
          stdio: ["pipe", "pipe", "inherit"],
        })
        let printed = ""
        child.stdout.on("data", (data: Buffer) => (printed += data.toString()))
        child.on("exit", () => resolve(printed))
        child.stdin.end(JSON.stringify(payload))
      })
    await use({
      endpoint: listening.endpoint,
      script,
      reports,
      deadlines,
      answer,
      acks,
      hook,
      run,
    })
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
  it("forwards its event and the agent's payload to its terminal, with its token", async ({
    fixture,
  }) => {
    expect(await fixture.hook("claude", start(), {}, "SessionStart")).toBe(0)
    expect(fixture.reports).toEqual([
      {
        terminalId,
        token,
        agent: "claude",
        event: "SessionStart",
        seq: expect.any(Number),
        instance: expect.toSatisfy((value) => value === null || /^\d+$/.test(String(value))),
        env: { cursor: false },
        payload: start(),
      },
    ])
  })

  it("takes the event from the payload when its command names none", async ({ fixture }) => {
    await fixture.hook("claude", start({ hook_event_name: "Stop" }))
    expect(fixture.reports[0]?.event).toBe("Stop")
  })

  it("names the Claude Code process that ran it", async ({ fixture }) => {
    await fixture.hook("claude", start(), { CLAUDE_PID: "4242" }, "SessionStart")
    expect(fixture.reports[0]?.instance).toBe("4242")
  })

  // Linux tells a process's name and parent through /proc.
  it.runIf(process.platform === "linux")(
    "names the nearest ancestor with its agent's name as the agent process",
    async ({ fixture }) => {
      // A shell named codex that waits for the hook, as Codex runs its hooks.
      const directory = mkdtempSync(join(tmpdir(), "novadeck-codex-"))
      const codex = join(directory, "codex")
      symlinkSync("/bin/sh", codex)
      const pid = await new Promise<number | undefined>((resolve) => {
        const child = spawn(
          codex,
          ["-c", `"${process.execPath}" "${fixture.script}" codex SessionStart; true`],
          {
            env: {
              ...process.env,
              CLAUDE_PID: "",
              NOVADECK_TERMINAL_ID: terminalId,
              NOVADECK_REPORT: fixture.endpoint,
              NOVADECK_REPORT_TOKEN: token,
            },
            stdio: ["pipe", "ignore", "inherit"],
          },
        )
        child.stdin.end(JSON.stringify(start()))
        child.on("exit", () => resolve(child.pid))
      })
      rmSync(directory, { recursive: true, force: true })
      expect(fixture.reports[0]?.instance).toBe(String(pid))
    },
  )

  it("forwards only what tells nested agents apart of its environment", async ({ fixture }) => {
    await fixture.hook(
      "codex",
      start(),
      { CURSOR_VERSION: "1.0", CODEX_THREAD_ID: "t" },
      "SessionStart",
    )
    expect(fixture.reports[0]?.env).toEqual({ cursor: true, codexThread: "t" })
  })

  it("cuts long text short, so a report stays small", async ({ fixture }) => {
    await fixture.hook("claude", start({ prompt: "x".repeat(10_000) }), {}, "UserPromptSubmit")
    expect(String(fixture.reports[0]?.payload.prompt)).toHaveLength(4096)
  })

  it("reports when its process started, before Node reached its first line", async ({
    fixture,
  }) => {
    // A module Node loads before the hook, busy for a while as a loaded machine's boot is.
    const directory = dirname(fixture.script)
    const booted = join(directory, "booted")
    const slow = join(directory, "slow.mjs")
    writeFileSync(
      slow,
      `import { writeFileSync } from "node:fs"
const until = Date.now() + 400
while (Date.now() < until) {}
writeFileSync(${JSON.stringify(booted)}, String(Date.now()))
`,
    )
    await fixture.hook("claude", start(), { NODE_OPTIONS: `--import=${pathToFileURL(slow)}` })
    const [report] = fixture.reports
    expect(report!.seq).toBeLessThan(Number(readFileSync(booted, "utf8")) - 300)
  })

  it("orders reports by when each hook started", async ({ fixture }) => {
    await fixture.hook("claude", start(), {}, "SessionStart")
    await fixture.hook("claude", start({ source: "clear" }), {}, "SessionStart")
    const [first, second] = fixture.reports
    expect(second!.seq).toBeGreaterThan(first!.seq)
  })

  it("exits quietly outside NovaDeck's terminals and on anything malformed", async ({
    fixture,
  }) => {
    expect(await fixture.hook("claude", start(), { NOVADECK_TERMINAL_ID: "" })).toBe(0)
    expect(await fixture.hook("claude", "not json")).toBe(0)
    expect(await fixture.hook("claude", "42")).toBe(0)
    expect(await fixture.hook("gemini", start())).toBe(0)
    expect(fixture.reports).toEqual([])
  })

  it("answers Antigravity with JSON, letting its policy decide on tools", async ({ fixture }) => {
    const payload = { conversationId: session, workspacePaths: ["/work"], modelName: "auto" }
    expect(await fixture.hook("agy", payload, {}, "PreInvocation")).toBe(0)
    expect(await fixture.hook("agy", payload, {}, "PreToolUse")).toBe(0)
    expect(await fixture.hook("agy", payload, { NOVADECK_TERMINAL_ID: "" }, "PreToolUse")).toBe(0)
    expect(fixture.reports.map(({ event }) => event)).toEqual(["PreInvocation", "PreToolUse"])
  })

  // NovaDeck gives Windows no Claude Code status line yet.
  it.skipIf(process.platform === "win32")(
    "shows the person's own Claude Code status line after forwarding its snapshot",
    async ({ fixture }) => {
      const home = mkdtempSync(join(tmpdir(), "novadeck-claude-home-"))
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({ statusLine: { type: "command", command: "cat >/dev/null; echo mine" } }),
      )
      const printed = await fixture.run(
        "claude",
        { session_id: session, cwd: home, rate_limits: {} },
        { CLAUDE_CONFIG_DIR: home },
        "StatusLine",
      )
      rmSync(home, { recursive: true, force: true })
      expect(printed.trim()).toBe("mine")
      expect(fixture.reports.map(({ event }) => event)).toEqual(["StatusLine"])
    },
  )

  it.skipIf(process.platform === "win32")(
    "cuts off a status line that takes too long, keeping what it printed",
    async ({ fixture }) => {
      const home = mkdtempSync(join(tmpdir(), "novadeck-claude-home-"))
      const pidFile = join(home, "pid")
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({
          statusLine: {
            type: "command",
            command: `echo partial; echo $$ > '${pidFile}'; exec sleep 30`,
          },
        }),
      )
      const started = performance.now()
      const printed = await fixture.run(
        "claude",
        { session_id: session, cwd: home },
        { CLAUDE_CONFIG_DIR: home },
        "StatusLine",
      )
      expect(performance.now() - started).toBeLessThan(8_000)
      expect(printed.trim()).toBe("partial")
      const pid = Number(readFileSync(pidFile, "utf8"))
      const alive = () => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      await expect.poll(alive, { timeout: 3_000 }).toBe(false)
      rmSync(home, { recursive: true, force: true })
    },
    15_000,
  )

  it.skipIf(process.platform === "win32")(
    "cuts off a status line whose background process holds its output",
    async ({ fixture }) => {
      const home = mkdtempSync(join(tmpdir(), "novadeck-claude-home-"))
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({
          statusLine: { type: "command", command: "cat >/dev/null; (sleep 30 &); echo bg" },
        }),
      )
      const printed = await fixture.run(
        "claude",
        { session_id: session, cwd: home },
        { CLAUDE_CONFIG_DIR: home },
        "StatusLine",
      )
      rmSync(home, { recursive: true, force: true })
      expect(printed.trim()).toBe("bg")
    },
    15_000,
  )

  it("shows no status line of its own when the person has none", async ({ fixture }) => {
    const home = mkdtempSync(join(tmpdir(), "novadeck-claude-home-"))
    const printed = await fixture.run(
      "claude",
      { session_id: session, cwd: home },
      { CLAUDE_CONFIG_DIR: home },
      "StatusLine",
    )
    rmSync(home, { recursive: true, force: true })
    expect(printed).toBe("")
  })

  it("gives up without blocking the agent when NovaDeck is gone", async ({ fixture }) => {
    const code = await fixture.hook("claude", start(), {
      NOVADECK_REPORT: join(tmpdir(), "novadeck-missing", "reports.sock"),
    })
    expect(code).toBe(0)
  })
})

describe("agent hook asking", () => {
  const lease = "abcdefghijklmnopqrstuvwx"

  it("asks at a Stop, prints the runner's answer, then acknowledges its lease", async ({
    fixture,
  }) => {
    const stdout = `${JSON.stringify({ decision: "block", reason: "<novadeck-messages/>" })}\n`
    fixture.answer.current = { leaseId: lease, stdout }
    const payload = { hook_event_name: "Stop", session_id: session }
    await expect(fixture.run("claude", payload, {}, "Stop")).resolves.toBe(stdout)
    await expect.poll(() => fixture.acks).toEqual([{ terminalId, token, leaseId: lease }])
    // Its deadline leaves time, after the runner's answer, to print it and acknowledge.
    const [asked] = fixture.deadlines
    expect(asked?.event).toBe("Stop")
    expect(asked!.deadline - asked!.seq).toBeGreaterThan(2_000)
    expect(asked!.deadline - asked!.seq).toBeLessThanOrEqual(4_000)
    expect(fixture.reports).toMatchObject([{ event: "Stop", payload }])
  })

  it("asks at each harness's prompt time, printing exactly what the runner says", async ({
    fixture,
  }) => {
    const inject = `${JSON.stringify({ injectSteps: [{ ephemeralMessage: "m" }] })}\n`
    fixture.answer.current = { leaseId: null, stdout: inject }
    await expect(
      fixture.run("agy", { conversationId: session, invocationNum: 0 }, {}, "PreInvocation"),
    ).resolves.toBe(inject)
    fixture.answer.current = { leaseId: null, stdout: "" }
    await expect(
      fixture.run("codex", { session_id: session, prompt: "hi" }, {}, "UserPromptSubmit"),
    ).resolves.toBe("")
    // Nothing leased, nothing to acknowledge.
    expect(fixture.acks).toEqual([])
    expect(fixture.deadlines.map(({ event }) => event)).toEqual([
      "PreInvocation",
      "UserPromptSubmit",
    ])
  })

  it("only reports the hooks that don't ask", async ({ fixture }) => {
    fixture.answer.current = { leaseId: lease, stdout: "x" }
    await expect(fixture.run("claude", start(), {}, "SessionStart")).resolves.toBe("")
    await expect(fixture.run("agy", { conversationId: session }, {}, "PostToolUse")).resolves.toBe(
      "{}\n",
    )
    expect(fixture.deadlines).toEqual([])
    expect(fixture.reports).toHaveLength(2)
  })

  it("prints what it would without NovaDeck when the runner doesn't answer", async ({
    fixture,
  }) => {
    // Unheard: the runner failed, or was too slow.
    await expect(fixture.run("agy", { conversationId: session }, {}, "Stop")).resolves.toBe("{}\n")
    await expect(
      fixture.run("claude", { hook_event_name: "Stop", session_id: session }, {}, "Stop"),
    ).resolves.toBe("")
    // NovaDeck gone: Antigravity still gets its JSON.
    await expect(
      fixture.run(
        "agy",
        { conversationId: session },
        { NOVADECK_REPORT: join(tmpdir(), "novadeck-missing.sock") },
        "Stop",
      ),
    ).resolves.toBe("{}\n")
    expect(fixture.acks).toEqual([])
  })
})
