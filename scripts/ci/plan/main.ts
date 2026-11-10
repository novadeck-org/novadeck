import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { parseAffected } from "../../e2e/plan/plan.ts"
import { declaredReads, platformOf, workspacePackages } from "../../workspace/platform.ts"
import { readScope, type Scope, scopeFile } from "../../workspace/scopes.ts"
import { type Facts, followed, plan, type Workspace } from "./plan.ts"

// `node scripts/ci/plan/main.ts`: decides what a run's CI needs and prints the plan as JSON; in
// Actions it also sets the job's outputs `tests` (the packages on each system), `run`, `os`,
// `rows` and `quirks` (the E2E jobs), `package` and `event`. A pull request reads its changes
// from `BASE_SHA` and `HEAD_SHA` (the full history must be there), and so does a merge queue's
// group, its `merge_group.base_sha` and `merge_group.head_sha` given as those; any other event,
// or anything that can't be read, runs everything. No workflow reads it yet.

const root = join(import.meta.dirname, "..", "..", "..")
const pins = join(root, "backend", "runner", "src", "e2e", "harnesses.json")

const run = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string | undefined => {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    })
  } catch (error) {
    console.error(
      `${command} ${args.join(" ")} failed: ${error instanceof Error ? error.message : error}`,
    )
    return undefined
  }
}

const packages = (): readonly Workspace[] | undefined => {
  try {
    const found = workspacePackages(root).map(({ folder, manifest }) => ({
      name: String(manifest.name),
      folder,
      platform: platformOf(manifest),
      reads: declaredReads(manifest),
    }))
    const unread = found.find(({ reads }) => reads === undefined)
    if (unread) throw new Error(`${unread.folder}'s novadeck.reads isn't a list of paths`)
    return found.map((each) => ({ ...each, reads: each.reads ?? [] }))
  } catch (error) {
    console.error(`The workspace's packages couldn't be read: ${error}`)
    return undefined
  }
}

/** The scopes of the folders outside every package, from each `ci-scope.json` git tracks. */
const scopes = (env: NodeJS.ProcessEnv): readonly Scope[] | undefined => {
  const listed = run(
    "git",
    ["-c", "core.quotePath=false", "ls-files", "-z", "-co", "--exclude-standard"],
    env,
  )
  if (listed === undefined) return undefined
  const files = listed.split("\0").filter((file) => file.split("/").at(-1) === scopeFile)
  const read = files.map((file) => readScope(dirname(file), readFileSync(join(root, file), "utf8")))
  const unread = files.find((_, index) => read[index] === undefined)
  if (unread !== undefined) {
    console.error(`${unread} isn't a scope: running everything.`)
    return undefined
  }
  return read.filter((scope): scope is Scope => scope !== undefined)
}

const facts = (event: string, base: string | undefined, head: string | undefined): Facts => {
  const none = {
    packages: undefined,
    scopes: undefined,
    affected: undefined,
    files: undefined,
    suite: undefined,
  }
  if (!followed.includes(event)) return { event, ...none, packaged: undefined }
  if (!base || !head) {
    console.error("BASE_SHA or HEAD_SHA is missing: running everything.")
    return { event, ...none, packaged: undefined }
  }
  const env = { ...process.env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head }
  const turbo = (...args: string[]) => {
    const output = run("pnpm", ["exec", "turbo", "ls", ...args, "--output", "json"], env)
    return output === undefined ? undefined : parseAffected(output)
  }
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
    packages: packages(),
    scopes: scopes(env),
    affected: turbo("--affected"),
    files: diff?.split("\0").filter(Boolean),
    suite: turbo("--filter", "@novadeck/runner..."),
    packaged: turbo("--filter", "@novadeck/desktop..."),
  }
}

export const main = (): void => {
  const ids = Object.keys(JSON.parse(readFileSync(pins, "utf8")) as object)
  const found = facts(
    process.env.GITHUB_EVENT_NAME ?? "",
    process.env.BASE_SHA,
    process.env.HEAD_SHA,
  )
  const decided = plan(found, ids)
  console.error(
    decided.everything === undefined
      ? `${found.affected?.length} affected packages, ${found.files?.length} changed files`
      : `Everything runs: ${decided.everything}.`,
  )
  console.log(JSON.stringify(decided, null, 2))
  const output = process.env.GITHUB_OUTPUT
  if (output)
    appendFileSync(
      output,
      [
        `tests=${JSON.stringify(decided.tests)}`,
        `run=${decided.e2e.run}`,
        `os=${JSON.stringify(decided.e2e.os)}`,
        `rows=${JSON.stringify(decided.e2e.rows)}`,
        `quirks=${JSON.stringify(decided.e2e.quirks)}`,
        `package=${decided.package}`,
        `event=${decided.event}`,
        "",
      ].join("\n"),
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
