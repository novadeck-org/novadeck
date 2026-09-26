import { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"

import * as pty from "node-pty"
import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { command, ptyOptions } from "../testing/pty.js"
import type { Resources } from "../testing/resources.js"

const bounded = async <T>(operation: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const spawn = (
  resources: Resources,
  args = ptyOptions.shellArgs,
  options: { useConptyDll?: boolean } = {},
) => {
  // Exercise the installed native package directly so failures retain their cause.
  const child = pty.spawn(process.execPath, args, {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    ...options,
  })
  const events = new EventEmitter()
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
  const ended = child.onExit((event) => {
    exited = true
    resolveExit(event)
    events.emit("exit")
  })
  resources.defer(async () => {
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
    if (output.includes(marker)) return
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
      await bounded(found, `PTY ${child.pid} output ${marker}`)
    } finally {
      events.removeAllListeners("data")
      events.removeAllListeners("exit")
    }
  }
  return { child, until, exit: () => bounded(exit, `PTY ${child.pid} exit`), output: () => output }
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
  it("starts a child and delivers its final output without hiding native startup errors", async ({
    resources,
  }) => {
    const terminal = spawn(resources, ["-e", 'process.stdout.write("NATIVE_PTY_OK")'])
    expect((await terminal.exit()).exitCode).toBe(0)
    expect(terminal.output()).toContain("NATIVE_PTY_OK")
  }, 20_000)

  it("keeps repeated child sessions alive for multiple writes and their natural exit", async ({
    resources,
  }) => {
    for (let session = 0; session < 6; session++) {
      const terminal = spawn(resources)
      // eslint-disable-next-line no-await-in-loop -- Each session must finish before its successor starts.
      await terminal.until("PTY_READY")
      for (let write = 0; write < 3; write++) {
        const marker = `NATIVE_SESSION_${session}_WRITE_${write}`
        terminal.child.write(command({ type: "write", data: marker }))
        // eslint-disable-next-line no-await-in-loop -- The reply proves the previous write reached a live child.
        await terminal.until(marker)
      }
      const final = `NATIVE_SESSION_${session}_FINAL`
      terminal.child.write(command({ type: "exit", code: 7, data: final }))
      // eslint-disable-next-line no-await-in-loop -- Verify complete shutdown before the next native startup.
      expect((await terminal.exit()).exitCode).toBe(7)
      expect(terminal.output()).toContain(final)
    }
  }, 60_000)

  it("closes repeated running children after their first output", async ({ resources }) => {
    for (let session = 0; session < 6; session++) {
      const terminal = spawn(resources)
      // eslint-disable-next-line no-await-in-loop -- Wait for native startup before explicitly closing this child.
      await terminal.until("PTY_READY")
      terminal.child.kill()
      // eslint-disable-next-line no-await-in-loop -- Every child must exit before starting its successor.
      await terminal.exit()
    }
  }, 60_000)

  it.skipIf(process.platform !== "darwin")(
    "releases PTY and kqueue descriptors across successful native spawns",
    async ({ resources }) => {
      const warmup = spawn(resources, ["-e", "process.exit(0)"])
      await warmup.exit()
      await settle()
      const before = descriptors()
      for (let session = 0; session < 24; session++) {
        const terminal = spawn(resources, ["-e", "process.exit(0)"])
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
    async ({ resources }) => {
      const warmup = spawn(resources, ["-e", "process.exit(0)"])
      await warmup.exit()
      await settle()
      const before = descriptors()
      // Exceed macOS ARG_MAX without creating a child or exhausting system resources.
      const argument = "x".repeat(1024 * 1024)
      for (let session = 0; session < 24; session++) {
        expect(() => spawn(resources, ["-e", "process.exit(0)", argument])).toThrow()
      }
      await settle()
      expect(descriptors()).toEqual(before)
    },
    60_000,
  )

  it.skipIf(process.platform !== "win32").for([
    { conpty: "system", useConptyDll: false },
    { conpty: "bundled", useConptyDll: true },
  ])(
    "ends a Windows terminal whose input failed instead of crashing the process ($conpty ConPTY)",
    async ({ useConptyDll }, { resources }) => {
      const terminal = spawn(resources, ptyOptions.shellArgs, { useConptyDll })
      await terminal.until("PTY_READY")
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      resources.defer(() => warn.mockRestore())
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
