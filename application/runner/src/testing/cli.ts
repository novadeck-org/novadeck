import { execFile, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { connectRunner, websocket } from "@novadeck/protocol/client"

import type { Resources } from "./resources.js"

const executable = fileURLToPath(new URL("../../dist/cli.js", import.meta.url))
const execute = promisify(execFile)

const bounded = async <T>(operation: Promise<T>, description: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), 10_000)
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Starts the distributed CLI, including its cwd-based environment-file loading. */
export const launchCli = async (directory: string, resources: Resources) => {
  const environment = { ...process.env }
  const configured = new Set([
    "HOST",
    "PORT",
    "CORS_ORIGINS",
    "NOVADECK_TOKEN",
    "NOVADECK_DATABASE",
    "SHELL",
  ])
  if (process.platform === "win32") configured.add("COMSPEC")
  for (const name of Object.keys(environment)) {
    if (configured.has(name.toUpperCase())) delete environment[name]
  }
  const child = spawn(process.execPath, [executable], {
    cwd: directory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  let diagnostics = ""
  child.stderr.on("data", (data: Buffer) => {
    diagnostics += data.toString()
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return exited
    if (process.platform === "win32") {
      if (child.pid === undefined) throw new Error("Runner did not acquire a process ID")
      // Node cannot handle SIGTERM on Windows. Kill only this test's owned tree,
      // including any PTY still alive when an assertion failed.
      await bounded(
        execute("taskkill", ["/PID", String(child.pid), "/T", "/F"]),
        "Runner process tree did not stop",
      )
      return bounded(exited, "Runner did not exit after taskkill")
    }
    child.kill("SIGTERM")
    try {
      return await bounded(exited, `Runner did not stop: ${diagnostics}`)
    } catch (error) {
      child.kill("SIGKILL")
      await bounded(exited, "Runner did not exit after SIGKILL")
      throw error
    }
  }
  resources.defer(async () => {
    await stop()
  })
  const ready = new Promise<string>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", () => reject(new Error(`Runner exited before listening: ${diagnostics}`)))
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString()
      const origin = /NovaDeck runner listening at (http:\/\/[^\s]+)/.exec(output)?.[1]
      if (origin !== undefined) resolve(origin)
    })
  })
  const origin = await bounded(ready, "Built runner did not announce its listener")

  /** Connects through the public runner client, closed with the test's resources. */
  const connect = async (token: string) => {
    const runner = await bounded(
      connectRunner(websocket(`${origin.replace(/^http/, "ws")}/api/rpc`, { token })),
      "Built runner client did not connect",
    )
    resources.defer(() => runner.close())
    return runner
  }
  return { origin, connect, stop, output: () => output, diagnostics: () => diagnostics }
}
