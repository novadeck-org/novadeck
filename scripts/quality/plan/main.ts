import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { join } from "node:path"

import { parseAffected } from "../../e2e/plan/plan.ts"
import { workspacePackages } from "../../workspace/platform.ts"
import { type Facts, plan } from "./plan.ts"

// `node scripts/quality/plan/main.ts`: decides which systems Quality's tests run on and prints
// the plan as JSON; in Actions it also sets the job's outputs `windows`, `macos`, `held` and `packages`. A draft (`DRAFT`)
// holds macOS back. A pull
// request reads its changes from `BASE_SHA` and `HEAD_SHA` (the full history must be there);
// any other event, or anything that can't be read, runs every system.

const root = join(import.meta.dirname, "..", "..", "..")

const run = (args: readonly string[], env: NodeJS.ProcessEnv): string | undefined => {
  try {
    return execFileSync(args[0]!, args.slice(1), {
      cwd: root,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "inherit"],
    })
  } catch (error) {
    console.error(`${args.join(" ")} failed: ${error instanceof Error ? error.message : error}`)
    return undefined
  }
}

const facts = (event: string, base: string | undefined, head: string | undefined): Facts => {
  if (event !== "pull_request") return { event, affected: undefined, files: undefined }
  // Only a pull request's payload says so; a `merge_group` or anything else runs macOS.
  const draft = process.env.DRAFT === "true"
  if (!base || !head) {
    console.error("BASE_SHA or HEAD_SHA is missing: running every system.")
    return { event, affected: undefined, files: undefined, draft }
  }
  const env = { ...process.env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head }
  const turbo = run(["pnpm", "exec", "turbo", "ls", "--affected", "--output", "json"], env)
  // Unquoted and NUL-separated, so a path with spaces or non-ASCII letters reads as it is.
  const diff = run(
    [
      "git",
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
    files: diff?.split("\0").filter(Boolean),
    draft,
  }
}

export const main = (): void => {
  const found = facts(
    process.env.GITHUB_EVENT_NAME ?? "",
    process.env.BASE_SHA,
    process.env.HEAD_SHA,
  )
  console.error(
    `${found.event || "no event"}: ${found.affected?.length ?? "unknown"} affected packages, ${found.files?.length ?? "unknown"} changed files`,
  )
  const decided = plan(found, workspacePackages(root))
  console.log(JSON.stringify(decided, null, 2))
  const output = process.env.GITHUB_OUTPUT
  if (output)
    appendFileSync(
      output,
      `windows=${decided.windows}\nmacos=${decided.macos}\nheld=${decided.held}\npackages=${JSON.stringify(decided.packages)}\n`,
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
