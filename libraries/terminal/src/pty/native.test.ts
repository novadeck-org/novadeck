import { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"

import * as pty from "node-pty"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { command, ptyChild, ptyChildEnv, ptyTrace } from "../testing.js"
// @ts-expect-error -- A diagnostic for #722 in plain JavaScript, to come out with it.
import { timeStart } from "../testing/conpty-probe.mjs"
import { spawnPty } from "./pty.js"

// How long a step may take. Under CI load, Windows' ConPTYs (the bundled one and the system's)
// hold input for seconds at a time while output flows (#712): a line that reaches a child in
// milliseconds on a quiet machine took 2 s, and past 10 s, on a busy runner.
const stepMs = process.platform === "win32" ? 30_000 : 10_000
// A test of several sessions, each of which may take its steps' time; on Windows, a bundled
// ConPTY also takes about 3 s to start its program in this file.
const sessionsMs = process.platform === "win32" ? 120_000 : 60_000

// Waits at most `stepMs`, then fails with `label` and what `stalled` tells of the terminal.
const bounded = async <T>(
  operation: Promise<T>,
  label: string,
  stalled: () => string = () => "",
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}${stalled()}`)),
          stepMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const spawn = (args = [ptyChild], options: { useConptyDll?: boolean } = {}) => {
  // Exercise the installed native package directly so failures retain their cause.
  const child = pty.spawn(process.execPath, args, {
    cwd: process.cwd(),
    // The child traces what reached it and what it wrote, which a stall reports.
    env: { ...process.env, ...ptyChildEnv },
    cols: 80,
    rows: 24,
    // On Windows, the ConPTY node-pty bundles, which `spawnPty` runs every terminal on.
    useConptyDll: process.platform === "win32",
    ...options,
  })
  const events = new EventEmitter()
  // The test's own steps, on the clock the children's trace keeps.
  const steps: string[] = []
  const step = (entry: string) => steps.push(`${new Date().toISOString()} ${entry}`)
  step(`spawned ${child.pid}`)
  let output = ""
  let exited = false
  const data = child.onData((chunk) => {
    output += chunk
    events.emit("data")
  })
  let resolveExit: (event: { exitCode: number }) => void
  const exit = new Promise<{ exitCode: number }>((resolve) => {
    resolveExit = resolve
  })
  // Whether the input was lost, the child never ended, or node-pty never told of its end.
  const stalled = () =>
    `; its last output ${JSON.stringify(output.slice(-160))}; the test's steps:\n${steps.join("\n")}\n` +
    `the children's trace:\n${ptyTrace(16)}\nnow ${new Date().toISOString()}`
  const ended = child.onExit((event) => {
    step(`told of the exit ${event.exitCode}`)
    exited = true
    resolveExit(event)
    events.emit("exit")
  })
  onTestFinished(async () => {
    try {
      if (!exited) child.kill()
      await bounded(exit, `PTY ${child.pid} cleanup`)
    } finally {
      data.dispose()
      ended.dispose()
      events.removeAllListeners()
    }
  })
  const until = async (marker: string) => {
    if (output.includes(marker)) return void step(`saw ${marker}`)
    if (exited) throw new Error(`PTY ${child.pid} exited before output ${marker}`)
    const found = new Promise<void>((resolve, reject) => {
      const check = () => {
        if (output.includes(marker)) resolve()
      }
      events.on("data", check)
      events.once("exit", () =>
        reject(new Error(`PTY ${child.pid} exited before output ${marker}`)),
      )
    })
    try {
      await bounded(found, `PTY ${child.pid} output ${marker}`, stalled)
      step(`saw ${marker}`)
    } finally {
      events.removeAllListeners("data")
      events.removeAllListeners("exit")
    }
  }
  return {
    child,
    // Writes `data` to the child, as one of the test's steps.
    write: (input: string, what: string) => {
      step(`wrote ${what}`)
      child.write(input)
    },
    until,
    exit: () => bounded(exit, `PTY ${child.pid} exit`, stalled),
    output: () => output,
  }
}

const descriptors = () => {
  const lines = execFileSync(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(process.pid), "-F", "pftn"],
    { encoding: "utf8", timeout: 10_000 },
  ).split("\n")
  // Missing or incomplete accounting must not turn this into a passing leak test.
  expect(lines).toContain(`p${process.pid}`)
  expect(lines).toContain("tKQUEUE")
  return {
    queues: lines.filter((line) => line === "tKQUEUE").length,
    terminals: lines.filter((line) => /^n\/dev\/(?:ptmx|pty|ttys)/.test(line)).length,
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 1_000))

describe("installed native PTY dependency", () => {
  it(
    "starts a child and delivers its final output without hiding native startup errors",
    async () => {
      const terminal = spawn(["-e", 'process.stdout.write("NATIVE_PTY_OK")'])
      expect((await terminal.exit()).exitCode).toBe(0)
      expect(terminal.output()).toContain("NATIVE_PTY_OK")
    },
    stepMs * 2,
  )

  it(
    "keeps repeated child sessions alive for multiple writes and their natural exit",
    async () => {
      for (let session = 0; session < 6; session++) {
        const terminal = spawn()
        // eslint-disable-next-line no-await-in-loop -- Each session must finish before its successor starts.
        await terminal.until("PTY_READY")
        for (let write = 0; write < 3; write++) {
          const marker = `NATIVE_SESSION_${session}_WRITE_${write}`
          terminal.write(command({ type: "write", data: marker }), `write ${marker}`)
          // eslint-disable-next-line no-await-in-loop -- The reply proves the previous write reached a live child.
          await terminal.until(marker)
        }
        const final = `NATIVE_SESSION_${session}_FINAL`
        terminal.write(command({ type: "exit", code: 7, data: final }), "exit 7")
        // eslint-disable-next-line no-await-in-loop -- Verify complete shutdown before the next native startup.
        expect((await terminal.exit()).exitCode).toBe(7)
        expect(terminal.output()).toContain(final)
      }
    },
    sessionsMs,
  )

  it(
    "closes repeated running children after their first output",
    async () => {
      for (let session = 0; session < 6; session++) {
        const terminal = spawn()
        // eslint-disable-next-line no-await-in-loop -- Wait for native startup before explicitly closing this child.
        await terminal.until("PTY_READY")
        terminal.child.kill()
        // eslint-disable-next-line no-await-in-loop -- Every child must exit before starting its successor.
        expect(await terminal.exit()).toHaveProperty("exitCode")
      }
    },
    sessionsMs,
  )

  it.skipIf(process.platform !== "darwin")(
    "releases PTY and kqueue descriptors across successful native spawns",
    async () => {
      const warmup = spawn(["-e", "process.exit(0)"])
      await warmup.exit()
      await settle()
      const before = descriptors()
      for (let session = 0; session < 24; session++) {
        const terminal = spawn(["-e", "process.exit(0)"])
        // eslint-disable-next-line no-await-in-loop -- Count descriptors only after all native child exits complete.
        expect((await terminal.exit()).exitCode).toBe(0)
      }
      // Native waiter threads can finish just after onExit; take one settled snapshot.
      await settle()
      expect(descriptors()).toEqual(before)
    },
    60_000,
  )

  it.skipIf(process.platform !== "darwin")(
    "releases PTY descriptors when native spawn rejects oversized arguments",
    async () => {
      const warmup = spawn(["-e", "process.exit(0)"])
      await warmup.exit()
      await settle()
      const before = descriptors()
      // Exceed macOS ARG_MAX without creating a child or exhausting system resources.
      const argument = "x".repeat(1024 * 1024)
      for (let session = 0; session < 24; session++) {
        expect(() => spawn(["-e", "process.exit(0)", argument])).toThrow(Error)
      }
      await settle()
      expect(descriptors()).toEqual(before)
    },
    60_000,
  )

  // Diagnostic for #722, to come out once CI has shown it: which variable explains a child's
  // first ~3 s on the bundled ConPTY. Written to stdout, which Vitest shows for a passing test.
  it.runIf(process.platform === "win32")(
    "diagnostic: times a child's start by how it was spawned",
    { timeout: 420_000 },
    async () => {
      const raw = (useConptyDll: boolean) => () => {
        const child = pty.spawn(process.execPath, [ptyChild], {
          cwd: process.cwd(),
          env: { ...process.env, ...ptyChildEnv },
          cols: 80,
          rows: 24,
          useConptyDll,
        })
        return { terminal: child, native: child }
      }
      const product = (cwd: string, env: NodeJS.ProcessEnv) => () => {
        let native: pty.IPty | undefined
        const terminal = spawnPty({
          file: process.execPath,
          args: [ptyChild],
          cwd,
          env,
          cols: 80,
          rows: 24,
          native: (...args) => (native = pty.spawn(...args)),
        })
        return { terminal, native }
      }
      const whole = { ...process.env, ...ptyChildEnv, TERM: "xterm-256color" }
      const { Path, PATH, SystemRoot, TEMP, TMP } = process.env
      const minimal = {
        PATH: PATH ?? Path,
        SystemRoot,
        TEMP,
        TMP,
        TERM: "xterm-256color",
      }
      const here = process.cwd()
      const variants = [
        ["(a) raw, bundled", raw(true), {}],
        ["(a+) raw, bundled, answered", raw(true), { answerAfterMs: 0 }],
        ["(a+1s) raw, bundled, answered after 1 s", raw(true), { answerAfterMs: 1_000 }],
        ["(system) raw, system", raw(false), {}],
        ["(b) spawnPty", product(here, whole), {}],
        ["(b+) spawnPty, answered", product(here, whole), { answerAfterMs: 0 }],
        ["(c) spawnPty, temp cwd", product(tmpdir(), whole), {}],
        ["(d) spawnPty, minimal env", product(here, minimal), {}],
        [
          "(d+) spawnPty, temp cwd, minimal env, answered",
          product(tmpdir(), minimal),
          { answerAfterMs: 0 },
        ],
      ] as const
      let runs = 0
      for (const [label, start, how] of variants)
        for (let run = 1; run <= 3; run++) {
          // eslint-disable-next-line no-await-in-loop -- One start at a time, for clean times.
          const line = (await timeStart(`${label} #${run}`, start, how)) as string
          // Each as it comes, so a timeout loses none of those before it.
          process.stdout.write(`ConPTY start: ${line}\n`)
          runs++
        }
      process.stdout.write(`The children's trace:\n${ptyTrace(60)}\n`)
      expect(runs).toBeGreaterThan(0)
    },
  )

  it.skipIf(process.platform !== "win32").for([
    { conpty: "system", useConptyDll: false },
    { conpty: "bundled", useConptyDll: true },
  ])(
    "ends a Windows terminal whose input failed instead of crashing the process ($conpty ConPTY)",
    async ({ useConptyDll }) => {
      const terminal = spawn([ptyChild], { useConptyDll })
      await terminal.until("PTY_READY")
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      onTestFinished(() => warn.mockRestore())
      // Our node-pty patch guards this private socket; unpatched, the emit below throws.
      const agent = (terminal.child as unknown as { _agent: { inSocket: NodeJS.EventEmitter } })
        // eslint-disable-next-line no-underscore-dangle -- The patched socket is private to node-pty.
        ._agent
      agent.inSocket.emit("error", Object.assign(new Error("write EAGAIN"), { code: "EAGAIN" }))
      expect(warn).toHaveBeenCalledWith(
        "node-pty ended a terminal after an input write failed: EAGAIN",
      )
      // A terminal that can no longer take input ends visibly; ending it again is harmless.
      await terminal.exit()
      expect(() => terminal.child.kill()).not.toThrow()
    },
  )
})
