import { execFileSync } from "node:child_process"
import { appendFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { facts, harnessIds } from "../../ci/plan/main.ts"
import { plan as graphPlan } from "../../ci/plan/plan.ts"
import { workspacePackages } from "../../workspace/platform.ts"
import { declarationDiffers, plan, proofChanges, proofRows, proves } from "./plan.ts"

// `node scripts/quality/plan/main.ts`: decides which systems Quality's tests run on, and which
// packages there, and prints the plan as JSON; in Actions it also sets the job's outputs
// `windows`, `macos`, `held`, `windows-rows`, `windows-packages`, `macos-rows` and `packages`,
// and `proof`, `proof-macos`, `proof-windows-rows` and `proof-macos-rows`: whether a pull
// request's run proves the narrowed rows (`proves`), on macOS too unless it's a draft, and
// their rows, each over the packages the plan gives one of `proofChanges` at its head.
// A draft (`DRAFT`) holds macOS back. What each system tests is scripts/ci/plan's: a pull
// request reads its changes from `BASE_SHA` and `HEAD_SHA` (the full history must be there),
// and so does a merge queue's group, its `merge_group.base_sha` and `head_sha` given as those;
// any other event, or anything that can't be read, runs every test on every system.

const root = join(import.meta.dirname, "..", "..", "..")

const git = (args: readonly string[], env: NodeJS.ProcessEnv = process.env, input?: string) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env,
    input,
    stdio: ["pipe", "pipe", "ignore"],
  }).trim()

/** A file at a commit, or `undefined` where it isn't there. */
const show = (commit: string, file: string): string | undefined => {
  try {
    return git(["show", `${commit}:${file}`])
  } catch {
    return undefined
  }
}

/**
 * A commit on `head` that changes `file` alone, a line added at its end, written to the
 * repository's objects through an index of its own: nothing checked out moves.
 */
export const changeCommit = (head: string, file: string): string => {
  const scratch = mkdtempSync(join(tmpdir(), "novadeck-proof-"))
  try {
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_AUTHOR_NAME: "Quality plan",
      GIT_AUTHOR_EMAIL: "plan@novadeck.invalid",
      GIT_COMMITTER_NAME: "Quality plan",
      GIT_COMMITTER_EMAIL: "plan@novadeck.invalid",
    }
    const blob = git(["hash-object", "-w", "--stdin"], env, `${show(head, file) ?? ""}\n// proof\n`)
    git(["read-tree", head], env)
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], env)
    const tree = git(["write-tree"], env)
    return git(["commit-tree", tree, "-p", head, "-m", `proof: ${file}`], env)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The packages the plan gives each of `proofChanges` on `head`, by system and key; a change it
 * couldn't plan gets none, which the proof row reads as every system package.
 */
const proofLists = (head: string | undefined) => {
  const lists = {
    windows: {} as Record<string, readonly string[]>,
    macos: {} as Record<string, readonly string[]>,
  }
  if (!head) return lists
  const packages = workspacePackages(root)
  for (const { key, change } of proofChanges) {
    try {
      const commit = changeCommit(head, change)
      const tests = graphPlan(facts("pull_request", head, commit), harnessIds()).tests
      const decided = plan({ tests }, packages)
      lists.windows[key] = decided.windowsPackages
      lists.macos[key] = decided.packages
    } catch (error) {
      console.error(
        `The proof row for ${change} tests every system package: ${error instanceof Error ? error.message : error}`,
      )
    }
  }
  return lists
}

export const main = (): void => {
  const event = process.env.GITHUB_EVENT_NAME ?? ""
  const gathered = facts(event, process.env.BASE_SHA, process.env.HEAD_SHA)
  const graph = graphPlan(gathered, harnessIds())
  console.error(
    graph.everything === undefined
      ? `${event}: Windows tests ${graph.tests.windows.length} packages, macOS ${graph.tests.macos.length}`
      : `Everything runs: ${graph.everything}.`,
  )
  // Only a pull request's payload says so; a merge group, or anything else, runs macOS.
  const draft = event === "pull_request" && process.env.DRAFT === "true"
  const decided = plan({ tests: graph.tests, draft }, workspacePackages(root))
  const { BASE_SHA: base, HEAD_SHA: head } = process.env
  const proof =
    event === "pull_request" &&
    proves(gathered.files, (manifest) =>
      base && head ? declarationDiffers(show(base, manifest), show(head, manifest)) : true,
    )
  // A draft runs no macOS job, the proof rows' included: marking it ready runs them.
  const proofMacos = proof && !draft
  const lists = proof ? proofLists(head) : { windows: {}, macos: {} }
  console.log(JSON.stringify({ ...decided, proof, proofMacos, proofLists: lists }, null, 2))
  const output = process.env.GITHUB_OUTPUT
  if (output)
    appendFileSync(
      output,
      [
        `windows=${decided.windows}`,
        `macos=${decided.macos}`,
        `held=${decided.held}`,
        `windows-rows=${JSON.stringify(decided.windowsRows)}`,
        `windows-packages=${JSON.stringify(decided.windowsPackages)}`,
        `macos-rows=${JSON.stringify(decided.macosRows)}`,
        `packages=${JSON.stringify(decided.packages)}`,
        `proof=${proof}`,
        `proof-macos=${proofMacos}`,
        `proof-windows-rows=${JSON.stringify(proofRows("windows", lists.windows))}`,
        `proof-macos-rows=${JSON.stringify(proofRows("macos", lists.macos))}`,
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
