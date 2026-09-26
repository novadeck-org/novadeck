import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll } from "vitest"

/** Every fixture child in this test process appends what it received and wrote here. */
const tracePath = join(tmpdir(), `novadeck-pty-trace-${process.pid}.log`)
afterAll(() => rmSync(tracePath, { force: true }))

export const ptyOptions = {
  shell: process.execPath,
  shellArgs: [fileURLToPath(new URL("./pty-child.mjs", import.meta.url))],
  env: { NOVADECK_PTY_TRACE: tracePath },
}

/** The last fixture child trace lines, for diagnosing a stalled terminal. */
export const ptyTrace = (lines = 12): string => {
  try {
    return readFileSync(tracePath, "utf8").trimEnd().split("\n").slice(-lines).join("\n")
  } catch {
    return "(no trace)"
  }
}

export const command = (
  value:
    | { type: "write"; data: string }
    | { type: "info"; cols?: number; rows?: number }
    | { type: "burst"; data: string; count: number }
    | { type: "startNoise" }
    | { type: "stopNoise" }
    | { type: "styled"; cols: number; lines: number; checkpoint?: string }
    | { type: "exit"; code?: number; data?: string },
): string => `${Buffer.from(JSON.stringify(value)).toString("base64")}\n`
