import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"

import { parseFolders, plan } from "./plan.ts"

// `node scripts/package/plan/main.ts`: decides whether the Release workflow packages, and
// prints `true` or `false`; in Actions it also sets the job's output `package`. A pull
// request reads its changes from `BASE_SHA` and `HEAD_SHA` (the full history must be there);
// any other event, or anything that can't be read, packages.

const run = (command: string, args: readonly string[]): string | undefined => {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  } catch (error) {
    console.error(
      `${command} ${args.join(" ")} failed: ${error instanceof Error ? error.message : error}`,
    )
    return undefined
  }
}

const facts = (event: string, base: string | undefined, head: string | undefined) => {
  if (event !== "pull_request") return { event, packaged: undefined, files: undefined }
  if (!base || !head) {
    console.error("BASE_SHA or HEAD_SHA is missing: packaging.")
    return { event, packaged: undefined, files: undefined }
  }
  // The host and every package it's built from, its build's dependencies included.
  const turbo = run("pnpm", [
    "exec",
    "turbo",
    "ls",
    "--filter=@novadeck/desktop...",
    "--output",
    "json",
  ])
  // Unquoted and NUL-separated, so a path with spaces or non-ASCII letters reads as it is.
  const diff = run("git", [
    "-c",
    "core.quotePath=false",
    "diff",
    "-z",
    "--name-only",
    "--no-renames",
    `${base}...${head}`,
  ])
  return {
    event,
    packaged: turbo === undefined ? undefined : parseFolders(turbo),
    files: diff?.split("\0").filter(Boolean),
  }
}

export const main = (): void => {
  const found = facts(
    process.env.GITHUB_EVENT_NAME ?? "",
    process.env.BASE_SHA,
    process.env.HEAD_SHA,
  )
  console.error(
    `${found.event || "no event"}: ${found.packaged?.length ?? "unknown"} packaged packages, ${found.files?.length ?? "unknown"} changed files`,
  )
  const decided = plan(found)
  console.log(decided)
  const output = process.env.GITHUB_OUTPUT
  if (output) appendFileSync(output, `package=${decided}\n`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
