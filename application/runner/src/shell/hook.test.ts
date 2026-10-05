import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { relayPath } from "@novadeck/relay"

import { agents, harnesses } from "../harnesses/registry.js"
import { describe, expect, it as base } from "../test.js"
import { relayHook } from "./hook.js"
import { installShellFiles } from "./install.js"
import {
  listenForReports,
  unanswered,
  unheard,
  type Ack,
  type HookAnswer,
  type Report,
} from "./reports.js"
import { relayConfig } from "./scripts.js"

type Fixture = {
  endpoint: string
  reports: Report[]
  /** When the runner took each report, in epoch milliseconds. */
  received: number[]
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

// The relay's configuration, as the runner writes it beside the relay.
const relayConfigFile = join(mkdtempSync(join(tmpdir(), "novadeck-relay-config-")), "relay.json")
writeFileSync(relayConfigFile, JSON.stringify(relayConfig))

const terminalId = "00000000-0000-4000-8000-000000000001"
// Shaped like a runner's token: 48 hex digits.
const token = "0123456789abcdef".repeat(3)
const session = "11111111-2222-4333-8444-555555555555"

const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const reports: Report[] = []
    const received: number[] = []
    const deadlines: Fixture["deadlines"] = []
    const answer = { current: unheard }
    const acks: Ack[] = []
    const listening = await listenForReports({
      report: (report) => {
        reports.push(report)
        received.push(Date.now())
      },
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
        const child = spawn(
          relayPath,
          ["hook", "--config", relayConfigFile, agent, ...(event ? [event] : [])],
          {
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
          },
        )
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
        const child = spawn(relayPath, ["hook", "--config", relayConfigFile, agent, event], {
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
      reports,
      received,
      deadlines,
      answer,
      acks,
      hook,
      run,
    })
  },
})

// Runs the hook launcher as an agent's hook command does, cmd running it on Windows, and
// resolves what it printed.
const launched = (launcher: string, args: readonly string[], env: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve) => {
    const [command, given] =
      process.platform === "win32"
        ? [process.env.COMSPEC || "cmd.exe", ["/d", "/c", launcher, ...args]]
        : [launcher, args]
    const child = spawn(command, given, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    })
    let printed = ""
    child.stdout.on("data", (data: Buffer) => (printed += data.toString()))
    child.on("exit", () => resolve(printed))
    // cmd's own answer reads none of it.
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify({ conversationId: session }))
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

  // Linux and macOS tell a process's name and parent; Windows doesn't.
  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "names the nearest ancestor with its agent's name, as started through a symlink",
    async ({ fixture, resources }) => {
      // bash, by a symlink named codex, running the hook as Codex runs its hooks, as a
      // package manager installs a program by a symlink to the file it runs. bash stays the
      // hook's parent, as the command goes on after it.
      const directory = mkdtempSync(join(tmpdir(), "novadeck-codex-"))
      resources.defer(() => rmSync(directory, { recursive: true, force: true }))
      const codex = join(directory, "codex")
      symlinkSync("/bin/bash", codex)
      const pid = await new Promise<number | undefined>((resolve) => {
        const child = spawn(
          codex,
          ["-c", `"${relayPath}" hook --config '${relayConfigFile}' codex SessionStart; true`],
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
      await expect.poll(() => fixture.reports[0]?.instance).toBe(String(pid))
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

  it("reports when it started, in wall-clock milliseconds", async ({ fixture }) => {
    const began = Date.now()
    await fixture.hook("claude", start(), {}, "SessionStart")
    const [report] = fixture.reports
    // The relay's clock and Node's agree within a few milliseconds, not to the fraction.
    expect(report!.seq).toBeGreaterThan(began - 50)
    expect(report!.seq).toBeLessThan(fixture.received[0]! + 50)
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

  it("reads its agent's whole payload even outside NovaDeck, so the agent can write it", async () => {
    const written = await new Promise<Error | undefined>((resolve) => {
      const child = spawn(relayPath, ["hook", "--config", relayConfigFile, "claude", "Stop"], {
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "ignore", "inherit"],
      })
      let failed: Error | undefined
      child.stdin.on("error", (error) => (failed = error))
      child.on("exit", () => resolve(failed))
      child.stdin.end(JSON.stringify({ hook_event_name: "Stop", padding: "x".repeat(500_000) }))
    })
    expect(written).toBeUndefined()
  })

  it("waits for an unanswering runner, through its launcher, only as long as the hook may", async ({
    resources,
  }) => {
    // A runner that takes the hook and never answers; reading on, so it hears the hook go.
    const directory = mkdtempSync(join(tmpdir(), "novadeck-silent-"))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    // As the runner's endpoint: a named pipe on Windows, a socket elsewhere.
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\novadeck-silent-${process.pid}-${Date.now()}`
        : join(directory, "reports.sock")
    const silent = createServer((socket) => socket.resume())
    await new Promise<void>((resolve) => silent.listen(endpoint, resolve))
    resources.defer(() => new Promise<void>((resolve) => silent.close(() => resolve())))
    // The launcher as agents run it, which tells the relay which hooks ask.
    const { launcher } = await installShellFiles(join(directory, "shell"))
    const took = async (event: string) => {
      const began = performance.now()
      await launched(launcher, ["agy", event], {
        NOVADECK_TERMINAL_ID: terminalId,
        NOVADECK_REPORT: endpoint,
        NOVADECK_REPORT_TOKEN: token,
      })
      return performance.now() - began
    }
    // Two seconds to report, as the runner answers a report at once.
    const reported = await took("PostToolUse")
    expect(reported).toBeGreaterThan(1_500)
    expect(reported).toBeLessThan(3_500)
    // An ask has longer, for the runner to lease and answer by its deadline.
    expect(await took("Stop")).toBeGreaterThan(3_500)
  }, 30_000)

  it("still answers Antigravity through its launcher when its relay is missing", async ({
    resources,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-norelay-"))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    const paths = await installShellFiles(join(directory, "shell"))
    rmSync(paths.relay)
    const env = {
      NOVADECK_TERMINAL_ID: terminalId,
      NOVADECK_REPORT: "gone",
      NOVADECK_REPORT_TOKEN: token,
    }
    expect((await launched(paths.launcher, ["agy", "PreToolUse"], env)).trim()).toBe(
      '{"decision":"ask"}',
    )
    expect((await launched(paths.launcher, ["agy", "Stop"], env)).trim()).toBe("{}")
    expect(await launched(paths.launcher, ["claude", "Stop"], env)).toBe("")
  })

  it("still answers Antigravity through its launcher when what the relay reads is missing", async ({
    resources,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-noconfig-"))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    const paths = await installShellFiles(join(directory, "shell"))
    rmSync(paths.relayConfig)
    const env = {
      NOVADECK_TERMINAL_ID: terminalId,
      NOVADECK_REPORT: "gone",
      NOVADECK_REPORT_TOKEN: token,
    }
    expect((await launched(paths.launcher, ["agy", "PreToolUse"], env)).trim()).toBe(
      '{"decision":"ask"}',
    )
  })

  it("gives up within its limit when its agent never closes its input", async ({ fixture }) => {
    const began = performance.now()
    const printed = await new Promise<string>((resolve) => {
      const child = spawn(relayPath, ["hook", "--config", relayConfigFile, "agy", "PreToolUse"], {
        env: {
          ...process.env,
          NOVADECK_TERMINAL_ID: terminalId,
          NOVADECK_REPORT: fixture.endpoint,
          NOVADECK_REPORT_TOKEN: token,
        },
        stdio: ["pipe", "pipe", "inherit"],
      })
      let out = ""
      child.stdout.on("data", (data: Buffer) => (out += data.toString()))
      child.on("exit", () => resolve(out))
      child.stdin.write("{")
    })
    expect(printed).toBe('{"decision":"ask"}\n')
    expect(performance.now() - began).toBeLessThan(8_000)
    expect(fixture.reports).toEqual([])
  }, 15_000)

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

  // A multiplexer can outlive NovaDeck, its terminals still naming the runner gone.
  it.skipIf(process.platform === "win32")(
    "shows the person's own status line even when NovaDeck can't be reached",
    async ({ fixture, resources }) => {
      const home = mkdtempSync(join(tmpdir(), "novadeck-claude-home-"))
      resources.defer(() => rmSync(home, { recursive: true, force: true }))
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({ statusLine: { type: "command", command: "cat >/dev/null; echo mine" } }),
      )
      const printed = await fixture.run(
        "claude",
        { session_id: session, cwd: home },
        {
          CLAUDE_CONFIG_DIR: home,
          NOVADECK_REPORT: join(tmpdir(), "novadeck-missing", "reports.sock"),
        },
        "StatusLine",
      )
      expect(printed.trim()).toBe("mine")
    },
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

describe("reading a relay's hook", () => {
  const hook = (given: object = {}) => ({
    agent: "codex",
    event: "SessionStart",
    seq: 1_000,
    ancestors: [],
    env: {},
    payload: JSON.stringify(start()),
    ...given,
  })

  it("names the nearest ancestor with its agent's name, and Claude Code by its own pid", async () => {
    const ancestors = [
      { pid: 10, name: "sh" },
      { pid: 20, name: "codex" },
      { pid: 30, name: "codex" },
    ]
    expect(relayHook(hook({ ancestors }))?.report.instance).toBe("20")
    expect(relayHook(hook({ ancestors: [{ pid: 10, name: "sh" }] }))?.report.instance).toBe(null)
    const claude = hook({ agent: "claude", ancestors, env: { CLAUDE_PID: "4242" } })
    expect(relayHook(claude)?.report.instance).toBe("4242")
  })

  it("cuts a payload too large to keep harder, and drops one too large even then", async () => {
    const wide = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`k${index}`, "x".repeat(1_000)]),
    )
    const cut = relayHook(hook({ payload: JSON.stringify(wide) }))
    expect(String(cut?.report.payload.k0)).toHaveLength(200)
    const deep = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `k${index}`,
        Array.from({ length: 50 }, () => "x".repeat(200)),
      ]),
    )
    expect(relayHook(hook({ payload: JSON.stringify(deep) }))).toBeUndefined()
  })

  it("asks at the harness's asking events, with time left to print and acknowledge", async () => {
    const asked = relayHook(hook({ event: "Stop", seq: 1_000.4 }))
    expect(asked?.deadline).toBe(4_500)
    expect(relayHook(hook())?.deadline).toBeUndefined()
  })

  it("keeps to the deadline the relay names, within the most an ask has", () => {
    // A relay that gives up sooner is never answered after it.
    expect(relayHook(hook({ event: "Stop", seq: 1_000, deadline: 3_000 }))?.deadline).toBe(2_500)
    expect(relayHook(hook({ event: "Stop", seq: 1_000, deadline: 9_000 }))?.deadline).toBe(4_500)
    expect(relayHook(hook({ event: "Stop", seq: 1_000, deadline: "later" }))?.deadline).toBe(4_500)
  })

  it("tells the relay what each agent prints without NovaDeck, as its harness does", () => {
    for (const agent of agents) {
      for (const [event, text] of Object.entries(harnesses[agent].messaging.silent)) {
        expect(relayConfig.fallbacks[agent]?.[event]).toBe(text.trimEnd())
      }
      expect(relayConfig.asks[agent]).toEqual(Object.keys(harnesses[agent].messaging.asks))
    }
  })

  it("reads nothing of an unknown agent or a payload agents don't send", async () => {
    expect(relayHook(hook({ agent: "gemini" }))).toBeUndefined()
    expect(relayHook(hook({ payload: "[1]" }))).toBeUndefined()
    expect(relayHook(hook({ seq: "soon" }))).toBeUndefined()
  })
})
