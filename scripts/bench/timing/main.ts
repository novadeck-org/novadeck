import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { cpus, totalmem } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { drive, scenario } from "./drive.ts"
import { type Report, type Steady, type Switch, summarize } from "./report.ts"
import { openStack, type Stack } from "./stack.ts"

// `pnpm bench:timing [--output <file>]`: the timing run. The UI's production build in headless
// Chromium against a real runner in a sandbox, with fake agents sending real hooks and
// status-line telemetry (see drive.ts for the scenario). It writes a JSON report, by default
// to .cache/bench/timing.json. Its numbers are a trend, never a gate, so a run that fails to
// measure says why in the report's `error` and still exits 0; it exits 1 only when the
// sandbox leaked or refused to start, as `problems` says, as that's a boundary failing, not a
// number. Linux and macOS; on Linux CI it can run with no network at all:
// `node scripts/e2e/isolated/main.ts -- pnpm bench:timing`.

const root = join(import.meta.dirname, "..", "..", "..")
const { values } = parseArgs({ options: { output: { type: "string" } } })
const output = resolve(values.output ?? join(root, ".cache", "bench", "timing.json"))

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  } catch {
    return undefined
  }
})()

const startedAt = new Date().toISOString()
const measured: { agentPhases: (string | null)[]; steady: Steady[]; switches: Switch[] } = {
  agentPhases: [],
  steady: [],
  switches: [],
}
const environment: Record<string, string | number> = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cpus: cpus().length,
  cpu: cpus()[0]?.model ?? "unknown",
  memoryGB: Math.round(totalmem() / 1024 ** 3),
  ci: process.env.CI ? "yes" : "no",
}
const problems: string[] = []
let error: string | undefined

const describe = (cause: unknown) =>
  cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)

let stack: Stack | undefined
let finished: Promise<void> | undefined

/** Stops what runs, then writes the report, once, whether the run ended or was stopped. */
const finish = () =>
  (finished ??= (async () => {
    if (stack)
      problems.push(
        ...(await stack.stop().catch((cause: unknown) => [`stopping failed: ${describe(cause)}`])),
      )
    const report: Report = {
      version: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      commit,
      environment,
      scenario,
      summary: summarize(measured),
      samples: measured,
      problems,
      ...(error !== undefined && { error }),
    }
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ output, summary: report.summary, problems, error }, null, 2))
  })())

// Stopped from outside, as a cancelled CI job is: what runs stops, and the report says so.
// A signal while it stops, as a second Ctrl-C, is let be: stopping goes on, and so does
// the report.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    if (finished) return
    error ??= `stopped by ${signal}`
    void finish().finally(() => process.exit(problems.length > 0 ? 1 : 0))
  })

try {
  if (process.platform === "win32") throw new Error("the timing run needs Linux or macOS")
  try {
    stack = openStack()
  } catch (cause) {
    // The sandbox refused to start, as when its PATH holds a real agent CLI.
    problems.push(`the sandbox couldn't be made: ${describe(cause)}`)
    throw cause
  }
  const running = await stack.start()
  await drive(running, measured, (chromium) => {
    environment.chromium = chromium
  })
} catch (cause) {
  error ??= describe(cause)
}
await finish()
process.exitCode = problems.length > 0 ? 1 : 0
