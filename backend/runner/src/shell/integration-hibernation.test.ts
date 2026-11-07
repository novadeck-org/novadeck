import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { TerminalSummary } from "@novadeck/protocol"
import { vi } from "vitest"

import type { Terminals } from "../terminals/index.js"
import { describe, expect } from "../test.js"
import { bash, create, fakeAgent, it, type Fixture } from "./integration.test-support.js"

type Options = {
  /** A process it starts at once, as an MCP server is, before it is recorded. */
  readonly before?: boolean
  /** A process it starts after it is recorded, as a tool does. */
  readonly after?: boolean
  /** How long it takes to end once hung up, in milliseconds. */
  readonly slow?: number
}

/**
 * A stand-in for Claude Code in the shell's foreground: it reports a session and one
 * completed turn the way the plugin's hooks do, under its own pid, then waits.
 */
const standIn = (home: string, session: string, options: Options = {}): string => {
  const bin = join(home, "bin")
  mkdirSync(bin, { recursive: true })
  const script = join(bin, "hib-agent.cjs")
  writeFileSync(
    script,
    [
      'const net = require("node:net")',
      'const fs = require("node:fs")',
      'const { spawn } = require("node:child_process")',
      `const options = ${JSON.stringify(options)}`,
      `const session = ${JSON.stringify(session)}`,
      `const home = ${JSON.stringify(home)}`,
      "const { NOVADECK_TERMINAL_ID: terminalId, NOVADECK_REPORT_TOKEN: token } = process.env",
      'fs.writeFileSync(home + "/agent.pid", String(process.pid))',
      "const child = (name) => {",
      '  const started = spawn("sleep", ["600"], { stdio: "ignore" })',
      '  fs.writeFileSync(home + "/" + name + ".pid", String(started.pid))',
      "}",
      'if (options.before) child("before")',
      'if (options.after) setTimeout(() => child("after"), 350)',
      'if (options.slow) process.on("SIGHUP", () => setTimeout(() => process.exit(0), options.slow))',
      "const base = Date.now()",
      'const events = [["SessionStart", "startup"], ["UserPromptSubmit", ""], ["Stop", ""]]',
      "const send = (index) => {",
      '  if (index === events.length) { console.log("hib-agent reported"); return process.stdin.resume() }',
      "  const [event, source] = events[index]",
      "  const socket = net.connect(process.env.NOVADECK_REPORT)",
      '  socket.on("close", () => setTimeout(() => send(index + 1), 50))',
      "  const payload = { hook_event_name: event, session_id: session, source }",
      "  const hook = { relay: 2, kind: 'hook', terminalId, token, agent: 'claude', event, seq: base + index + 1, ancestors: [], env: { CLAUDE_PID: String(process.pid) }, payload: JSON.stringify(payload) }",
      '  let text = ""',
      '  socket.setEncoding("utf8")',
      '  socket.on("data", (chunk) => {',
      "    text += chunk",
      '    if (!text.includes("\\n")) return',
      "    const { leaseId } = JSON.parse(text)",
      '    socket.end(leaseId ? JSON.stringify({ ack: leaseId }) + "\\n" : undefined)',
      "  })",
      '  socket.write(JSON.stringify(hook) + "\\n")',
      "}",
      "send(0)",
    ].join("\n"),
  )
  writeFileSync(join(bin, "hib-agent"), `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`)
  chmodSync(join(bin, "hib-agent"), 0o755)
  fakeAgent(home, "claude")
  return bin
}

/** A manager that looks for idle agents every 100 ms and stops those quiet for 300 ms. */
const hibernating = (shell: Fixture, bin: string): Terminals =>
  shell.manager({
    env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
    hibernateAfterMinutes: () => 1,
    hibernation: { windowMs: 300, sweepMs: 100, baselineMs: 200 },
  })

const pidOf = (shell: Fixture, name: string): number =>
  Number(readFileSync(join(shell.home, `${name}.pid`), "utf8"))

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The terminal as the manager lists it. */
const listed = (manager: Terminals, shell: Fixture, id: string): TerminalSummary | undefined =>
  manager.list(shell.sessionId).find((each) => each.id === id)

/** Starts the stand-in in a new terminal, waits until it has reported its turn. */
const started = async (shell: Fixture, manager: Terminals, input = "hib-agent") => {
  const terminal = await create(manager, shell)
  manager.write({ terminalId: terminal.id, data: `${input}\r` }, "owner")
  await shell.until(manager, terminal.id, "hib-agent reported")
  return terminal.id
}

/** Whether the manager still holds the terminal's shell, as the record it lists. */
const awake = (manager: Terminals, shell: Fixture, id: string): boolean =>
  listed(manager, shell, id)?.sleeping === false

/** The record's own flag, which says the agent is being stopped. */
const stopping = (manager: Terminals, id: string): boolean =>
  (manager as unknown as { records: Map<string, { hibernating?: true }> }).records.get(id)
    ?.hibernating === true

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "bash shell integration: hibernating agents",
  () => {
    it("stops an idle agent, rests its session, and wakes it by a message on the same session", async ({
      shell,
    }) => {
      const bin = standIn(shell.home, "hib-session-1")
      const manager = hibernating(shell, bin)
      const id = await started(shell, manager)
      const pid = pidOf(shell, "agent")
      await vi.waitFor(
        () =>
          expect(listed(manager, shell, id)).toMatchObject({
            sleeping: true,
            restingAgent: "claude",
            started: false,
            exit: null,
          }),
        { timeout: 15_000 },
      )
      // The agent and its shell are gone, and the row says what resumes.
      expect(running(pid)).toBe(false)
      expect(shell.store.terminal(id)).toMatchObject({
        lastProgram: "claude",
        agents: { claude: { sessionId: "hib-session-1" } },
      })
      // A message wakes it: the shell the runner starts resumes the same session.
      const inside = manager as unknown as {
        messaging: { notice: (id: string, text: string, options: object) => boolean }
      }
      expect(inside.messaging.notice(id, "wake up", { always: true })).toBe(true)
      await vi.waitFor(() => expect(listed(manager, shell, id)?.started).toBe(true), {
        timeout: 15_000,
      })
      await shell.until(manager, id, "claude args: --resume hib-session-1")
    })

    it("does not announce an exit while it stops, nor list the terminal as gone", async ({
      shell,
    }) => {
      const bin = standIn(shell.home, "hib-session-2")
      const manager = hibernating(shell, bin)
      const next = shell.watch(manager)
      const id = await started(shell, manager)
      const sleeping = await next((terminal) => terminal.id === id && terminal.sleeping)
      expect(sleeping).toMatchObject({ exit: null, restingAgent: "claude" })
      expect(manager.list(shell.sessionId).map((each) => each.id)).toContain(id)
    })

    it("refuses an attach while it stops, and while it sleeps", async ({ shell }) => {
      const bin = standIn(shell.home, "hib-session-3", { slow: 600 })
      const manager = hibernating(shell, bin)
      const id = await started(shell, manager)
      await vi.waitFor(() => expect(stopping(manager, id)).toBe(true), { timeout: 15_000 })
      await expect(
        manager.attach({ terminalId: id, mode: "observe" }, "late").next(),
      ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
      await vi.waitFor(() => expect(listed(manager, shell, id)?.sleeping).toBe(true), {
        timeout: 15_000,
      })
      // Asleep, there is nothing to attach to until it is woken.
      await expect(
        manager.attach({ terminalId: id, mode: "observe" }, "later").next(),
      ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    })

    it("leaves nothing behind when the terminal is closed while its agent stops", async ({
      shell,
    }) => {
      const bin = standIn(shell.home, "hib-session-4", { slow: 600 })
      const manager = hibernating(shell, bin)
      const id = await started(shell, manager)
      await vi.waitFor(() => expect(stopping(manager, id)).toBe(true), { timeout: 15_000 })
      await manager.close({ terminalId: id })
      expect(listed(manager, shell, id)).toBeUndefined()
      expect(shell.store.terminal(id)).toBeUndefined()
      const inside = manager as unknown as {
        sleepers: { resting: (id: string) => unknown }
        messaging: { resting: (id: string) => unknown }
      }
      expect(inside.sleepers.resting(id)).toBeUndefined()
      expect(inside.messaging.resting(id)).toBeUndefined()
      // Not woken either, whatever is sent to it afterwards.
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(listed(manager, shell, id)).toBeUndefined()
    })

    it("keeps an agent awake while the shell has a job in the background, until it ends", async ({
      shell,
    }) => {
      const bin = standIn(shell.home, "hib-session-5")
      const manager = hibernating(shell, bin)
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "sleep 600 & echo $! > job.pid\r" }, "owner")
      await vi.waitFor(() => expect(existsSync(join(shell.home, "job.pid"))).toBe(true))
      manager.write({ terminalId: terminal.id, data: "hib-agent\r" }, "owner")
      await shell.until(manager, terminal.id, "hib-agent reported")
      // Many looks pass; the job `npm run dev &` stands for keeps it.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(awake(manager, shell, terminal.id)).toBe(true)
      const job = pidOf(shell, "job")
      expect(running(job)).toBe(true)
      process.kill(job)
      await vi.waitFor(() => expect(listed(manager, shell, terminal.id)?.sleeping).toBe(true), {
        timeout: 15_000,
      })
    })

    it("keeps an agent awake while a process it started after it was up runs, until it ends", async ({
      shell,
    }) => {
      const bin = standIn(shell.home, "hib-session-6", { after: true })
      const manager = hibernating(shell, bin)
      const id = await started(shell, manager)
      await vi.waitFor(() => expect(existsSync(join(shell.home, "after.pid"))).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(awake(manager, shell, id)).toBe(true)
      process.kill(pidOf(shell, "after"))
      await vi.waitFor(() => expect(listed(manager, shell, id)?.sleeping).toBe(true), {
        timeout: 15_000,
      })
    })

    it("stops an agent whose helpers were running before it was recorded, and them with it", async ({
      shell,
    }) => {
      const bin = standIn(shell.home, "hib-session-7", { before: true })
      const manager = hibernating(shell, bin)
      const id = await started(shell, manager)
      await vi.waitFor(() => expect(listed(manager, shell, id)?.sleeping).toBe(true), {
        timeout: 15_000,
      })
      await vi.waitFor(() => expect(running(pidOf(shell, "before"))).toBe(false))
    })

    it("never stops a plain shell, nor an agent while hibernation is off", async ({ shell }) => {
      const bin = standIn(shell.home, "hib-session-8")
      const off = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        hibernateAfterMinutes: () => null,
        hibernation: { windowMs: 100, sweepMs: 100, baselineMs: 100 },
      })
      const plain = await create(off, shell)
      const id = await started(shell, off)
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(awake(off, shell, plain.id)).toBe(true)
      expect(awake(off, shell, id)).toBe(true)
    })
  },
)
