import { spawn } from "node:child_process"
import { tmpdir } from "node:os"

import type { Ran, Run } from "@novadeck/forges"

import { cmdLine } from "../harnesses/service.js"
import { cmdPath, findProgram, killTree } from "../programs.js"

/** How long a forge's tool may take, and the most of its output that is kept. */
export const runLimits = {
  timeoutMs: 10_000,
  maxOutput: 1 << 20,
  maxSaid: 1 << 20,
} as const

/**
 * Variables that keep each forge's tool from ever asking anything or printing for a person:
 * Novadeck runs them with no terminal, and their answers are read as data.
 */
export const quietEnv: NodeJS.ProcessEnv = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
  NO_PROMPT: "1",
  GLAB_NO_PROMPT: "1",
  GLAB_CHECK_UPDATE: "false",
  AZURE_CORE_NO_COLOR: "true",
  AZURE_CORE_ONLY_SHOW_ERRORS: "true",
  AZURE_CORE_COLLECT_TELEMETRY: "false",
  AZURE_CORE_LOGIN_EXPERIENCE_V2: "off",
}

export type RunOptions = {
  /** The person's login environment, read each time a program runs. */
  readonly environment: () => NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly timeoutMs?: number
}

/**
 * The library's `Run` on the person's environment: the program is found on its PATH by an
 * absolute path, run with no shell, no terminal and no prompt, in the temporary folder
 * (no repository's own configuration applies), for `timeoutMs` at most, past which it ends
 * with all it started. A `.cmd` shim runs through cmd on Windows.
 */
export const createRun =
  ({
    environment,
    platform = process.platform,
    timeoutMs = runLimits.timeoutMs,
  }: RunOptions): Run =>
  (program, args) =>
    new Promise<Ran>((resolve) => {
      const person = environment()
      const found = findProgram(program, { env: person, platform })
      if (found === undefined) return resolve({ ok: false, kind: "missing", said: "" })
      const env = { ...person, ...quietEnv }
      const script = platform === "win32" && /\.(cmd|bat)$/i.test(found)
      const child = script
        ? spawn(cmdPath(env), ["/d", "/s", "/c", `"${cmdLine([found, ...args])}"`], {
            cwd: tmpdir(),
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsVerbatimArguments: true,
            windowsHide: true,
          })
        : spawn(found, args, {
            cwd: tmpdir(),
            env,
            stdio: ["ignore", "pipe", "pipe"],
            // Its own group, so the time limit ends what it started too.
            detached: platform !== "win32",
            windowsHide: true,
          })
      let out = ""
      let said = ""
      let settled = false
      const settle = (ran: Ran) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ran)
      }
      const timer = setTimeout(() => {
        killTree(child.pid, platform)
        settle({
          ok: false,
          kind: "timeout",
          said: said.slice(0, runLimits.maxSaid),
        })
      }, timeoutMs)
      child.on("error", (error: NodeJS.ErrnoException) =>
        settle({
          ok: false,
          kind: error.code === "ENOENT" ? "missing" : "exit",
          said: error.message,
        }),
      )
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        out += chunk
        if (out.length <= runLimits.maxOutput) return
        killTree(child.pid, platform)
        settle({ ok: false, kind: "exit", said: "Its output was too long." })
      })
      child.stderr.on("data", (chunk: string) => {
        if (said.length < runLimits.maxSaid) said += chunk
      })
      child.on("close", (code) =>
        settle(
          code === 0
            ? { ok: true, out, said }
            : {
                ok: false,
                kind: "exit",
                said: (said || out).slice(0, runLimits.maxSaid),
              },
        ),
      )
    })
