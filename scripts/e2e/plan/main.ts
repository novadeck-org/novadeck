import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"

import { parseAffected, plan } from "./plan.ts"

// `node scripts/e2e/plan/main.ts`: decides which E2E rows a run needs and prints the plan as
// JSON; in Actions it also sets the job's outputs `run`, `os`, `rows` and `quirks`. A pull request
// reads its changes from `BASE_SHA` and `HEAD_SHA` (the full history must be there); any
// other event, or anything that can't be read, runs everything.

const pins = new URL("../../../application/runner/src/e2e/harnesses.json", import.meta.url)

const run = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string | undefined => {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "inherit"],
    })
  } catch (error) {
    console.error(
      `${command} ${args.join(" ")} failed: ${error instanceof Error ? error.message : error}`,
    )
    return undefined
  }
}

const facts = (event: string, base: string | undefined, head: string | undefined) => {
  if (event !== "pull_request")
    return { event, affected: undefined, runner: undefined, files: undefined }
  if (!base || !head) {
    console.error("BASE_SHA or HEAD_SHA is missing: running everything.")
    return { event, affected: undefined, runner: undefined, files: undefined }
  }
  const env = { ...process.env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head }
  const turbo = run("pnpm", ["exec", "turbo", "ls", "--affected", "--output", "json"], env)
  // The runner and what it builds on: a change to any other package can't reach the suite.
  const closure = run(
    "pnpm",
    ["exec", "turbo", "ls", "--filter", "@novadeck/runner...", "--output", "json"],
    env,
  )
  // Unquoted and NUL-separated, so a path with spaces or non-ASCII letters reads as it is.
  const diff = run(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "-z",
      "--name-only",
      "--no-renames",
      `${base}...${head}`,
    ],
    env,
  )
  return {
    event,
    affected: turbo === undefined ? undefined : parseAffected(turbo),
    runner: closure === undefined ? undefined : parseAffected(closure),
    files: diff?.split("\0").filter(Boolean),
  }
}

export const main = (): void => {
  const ids = Object.keys(JSON.parse(readFileSync(pins, "utf8")) as object)
  const found = facts(
    process.env.GITHUB_EVENT_NAME ?? "",
    process.env.BASE_SHA,
    process.env.HEAD_SHA,
  )
  console.error(
    `${found.event || "no event"}: ${found.affected?.length ?? "unknown"} affected packages, ${found.files?.length ?? "unknown"} changed files`,
  )
  const decided = plan(found, ids)
  console.log(JSON.stringify(decided, null, 2))
  const output = process.env.GITHUB_OUTPUT
  if (output)
    appendFileSync(
      output,
      `run=${decided.run}\nos=${JSON.stringify(decided.os)}\nrows=${JSON.stringify(decided.rows)}\nquirks=${JSON.stringify(decided.quirks)}\n`,
    )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
