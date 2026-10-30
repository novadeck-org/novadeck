import { spawn, spawnSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
} from "node:fs"
import { availableParallelism } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { agyOutcome, type AgyOutcome, type AgyReport } from "./agy-results.ts"

// Each successful control gets a fresh Vitest/CLI process. A failure is never retried.
const root = fileURLToPath(new URL("../../", import.meta.url))
const run = (args: readonly string[], env: NodeJS.ProcessEnv, log: number): Promise<number> =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd: root,
      env,
      stdio: ["ignore", log, log],
    })
    const handlers = (["SIGINT", "SIGTERM"] as const).map(
      (signal) => [signal, () => child.kill(signal)] as const,
    )
    for (const [signal, handler] of handlers) process.on(signal, handler)
    const restore = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
    }
    child.once("error", (error) => {
      restore()
      reject(error)
    })
    child.once("exit", (code) => {
      restore()
      done(code ?? 1)
    })
  })

const readJson = <T>(file: string): T | undefined =>
  existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined

const main = async (): Promise<number> => {
  if (process.platform !== "linux")
    throw new Error("AGY capture requires the Linux network namespace wrapper")
  const { values } = parseArgs({
    options: { output: { type: "string" }, attempts: { type: "string", default: "5" } },
  })
  const attempts = Number(values.attempts)
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5)
    throw new Error("--attempts must be an integer from 1 to 5")
  if (!values.output) throw new Error("--output is required")
  const output = resolve(values.output)
  if (existsSync(output) && readdirSync(output).length > 0)
    throw new Error("--output must be a new or empty directory")
  mkdirSync(output, { recursive: true })
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
  if (head.status !== 0) throw new Error("Cannot identify the capture checkout")
  const expected = process.env.NOVADECK_CAPTURE_HEAD
  if (expected && head.stdout.trim() !== expected)
    throw new Error("Capture checkout does not match NOVADECK_CAPTURE_HEAD")
  const results: ({ attempt: number; code: number } & AgyOutcome)[] = []
  const save = () =>
    writeFileSync(
      join(output, "capture.json"),
      JSON.stringify(
        {
          scenario: "original-natural-order",
          head: head.stdout.trim(),
          node: process.version,
          platform: process.platform,
          cpus: availableParallelism(),
          attempts,
          results,
        },
        null,
        2,
      ),
    )
  save()
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const folder = join(output, `attempt-${attempt}`)
    mkdirSync(folder, { recursive: true })
    const log = openSync(join(folder, "vitest.log"), "w")
    console.log(`AGY natural-boundary capture ${attempt}/${attempts}: ${folder}`)
    let code: number
    try {
      // The standard CI wrapper creates a loopback-only namespace, as in the original run.
      // eslint-disable-next-line no-await-in-loop -- Fresh controls run sequentially; stop at the first failure.
      code = await run(
        [
          "scripts/e2e/isolated/main.ts",
          "--",
          "pnpm",
          "--filter",
          "@novadeck/runner",
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.agy-capture.config.ts",
          "--reporter=default",
          "--reporter=json",
          `--outputFile.json=${join(folder, "tests.json")}`,
        ],
        {
          ...process.env,
          NOVADECK_E2E_AGENTS: "agy",
          NOVADECK_E2E_HARNESS: "pinned",
          NOVADECK_E2E_PROBES: "1",
          NOVADECK_E2E_TRACE_ALL: "1",
          NOVADECK_E2E_TRACES: join(folder, "traces"),
          AGY_CAPTURE: "1",
          AGY_CAPTURE_OUT: folder,
        },
        log,
      )
    } finally {
      closeSync(log)
    }
    // Existing hook traces start with '..'; upload a visible copy, without hidden files.
    const traces = join(folder, "traces")
    if (existsSync(traces))
      for (const file of readdirSync(traces))
        if (file.endsWith(".txt")) copyFileSync(join(traces, file), join(folder, "hooks.txt"))
    const { outcome, error } = agyOutcome(
      readJson<{ outcome: string }>(join(folder, "summary.json")),
      readJson<AgyReport>(join(folder, "tests.json")),
    )
    results.push({ attempt, code, outcome, ...(error ? { error } : {}) })
    save()
    console.log(`AGY capture ${attempt}: ${outcome}, exit ${code}${error ? `: ${error}` : ""}`)
    if (code !== 0 || outcome !== "delivered") return code || 1
  }
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
