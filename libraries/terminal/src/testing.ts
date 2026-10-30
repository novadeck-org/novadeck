import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll } from "vitest"

import type { NativePty, NativeSpawn } from "./pty/pty.js"

// A controllable program to run in a real pty, for tests of what hosts one: it answers
// `command`s with output, sizes, bursts, exits and children of its own.

/** Every child in this test process appends what it received and wrote here. */
const tracePath = join(tmpdir(), `pty-child-trace-${process.pid}.log`)
afterAll(() => rmSync(tracePath, { force: true }))

/** The child's script, to run with Node in a pty. */
export const ptyChild = fileURLToPath(new URL("./testing/child.mjs", import.meta.url))

/** The environment the child traces itself with. */
export const ptyChildEnv = { PTY_CHILD_TRACE: tracePath }

/** The last trace lines, for diagnosing a stalled terminal. */
export const ptyTrace = (lines = 12): string => {
  try {
    return readFileSync(tracePath, "utf8").trimEnd().split("\n").slice(-lines).join("\n")
  } catch {
    return "(no trace)"
  }
}

/** A command for the child, as the line it reads. */
export const command = (
  value:
    | { type: "write"; data: string }
    | { type: "info"; cols?: number; rows?: number }
    | { type: "burst"; data: string; count: number }
    | { type: "startNoise" }
    | { type: "stopNoise" }
    | { type: "styled"; cols: number; lines: number; checkpoint?: string }
    | { type: "exit"; code?: number; data?: string }
    /** Starts a program that shares the terminal and runs until ended, reporting its id. */
    | { type: "spawn" }
    /** Renames the child, which Linux then reports as the terminal's foreground process. */
    | { type: "title"; value: string }
    /** Ignores hangups, so the child ends only when it is killed. */
    | { type: "ignoreHangup" },
): string => `${Buffer.from(JSON.stringify(value)).toString("base64")}\n`

/**
 * A stand-in for node-pty's terminal, which plays a ConPTY's quirks where `conpty`: its id
 * is 0 until its output connects, a kill is queued until it has drawn, and it can report an
 * exit before it knows the code.
 */
export const nativeStandIn = (o: { conpty?: boolean; pid?: number } = {}) => {
  const data = new Set<(data: string) => void>()
  const exits = new Set<(exit: { exitCode: number | undefined; signal?: number }) => void>()
  const calls: string[] = []
  let connected = !o.conpty
  let killQueued = false
  const exit = (exitCode: number | undefined, signal?: number) => {
    for (const listener of exits) listener({ exitCode, ...(signal ? { signal } : {}) })
  }
  const native: NativePty = {
    get pid() {
      return connected ? (o.pid ?? 2 ** 30) : 0
    },
    process: "shell",
    onData: (listener) => {
      data.add(listener)
      return { dispose: () => data.delete(listener) }
    },
    onExit: (listener) => {
      exits.add(listener)
      return { dispose: () => exits.delete(listener) }
    },
    write: (text) => calls.push(`write ${text}`),
    resize: (cols, rows) => calls.push(`resize ${cols}x${rows}`),
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    kill: (signal) => {
      if (o.conpty && signal) throw new Error("Signals not supported on windows.")
      calls.push(signal ? `kill ${signal}` : "kill")
      // A ConPTY's kill waits for its first draw; there, it ends the shell, whose code is
      // reported before it is known.
      if (o.conpty && !connected) killQueued = true
      else if (o.conpty) exit(undefined)
    },
  }
  return {
    native,
    calls,
    exit,
    // Output arrives, connecting a ConPTY's output and running a kill it queued.
    draw: (text: string) => {
      connected = true
      for (const listener of data) listener(text)
      if (killQueued) exit(undefined)
    },
    spawn: (() => native) as NativeSpawn,
  }
}
