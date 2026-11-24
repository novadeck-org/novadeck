import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** A Release run, as the Actions API lists it. */
export type ReleaseRun = {
  readonly id: number
  readonly event: string
  readonly status: string
  readonly createdAt: string
  readonly headSha: string
}

/** One of a run's jobs, as the Actions API lists it. */
export type Job = { readonly name: string; readonly status: string }

/** The push whose Release run supersedes older ones: its commit, and when this run started. */
export type Newer = { readonly headSha: string; readonly createdAt: string }

/** release.yml's publishing job; the API lists it only once Prepare and Package are done. */
export const publishJob = "Publish Experimental Release"

/** release.yml's jobs before publishing: Prepare, and the packaging it calls (`Package / macOS`). */
const builds = (name: string): boolean => name === "Prepare" || name.startsWith("Package /")

/**
 * Whether a newer push's Release run supersedes `run`, so cancelling it lets the newer one
 * start: it was started by an older push (or dispatch of that kind), holds the group now (a
 * pending run is GitHub's to replace), and is still building. Never once its publishing job is
 * listed, nor when every build job is done and publishing is about to be: a cancel inside
 * release-it could leave a tag without its release, which holds every release after it. A run
 * by hand releases a version its commits don't call for, so it is never cancelled.
 */
export const superseded = (run: ReleaseRun, jobs: readonly Job[], newer: Newer): boolean =>
  run.event !== "workflow_dispatch" &&
  run.status !== "completed" &&
  run.status !== "pending" &&
  run.headSha !== newer.headSha &&
  Date.parse(run.createdAt) < Date.parse(newer.createdAt) &&
  !jobs.some((job) => job.name === publishJob) &&
  jobs.some((job) => builds(job.name) && job.status !== "completed")

/** What `main` reads and does through GitHub, behind functions so tests run offline. */
export type GitHub = {
  readonly releaseRuns: () => Promise<ReleaseRun[]>
  readonly jobs: (runId: number) => Promise<Job[]>
  readonly cancel: (runId: number) => Promise<void>
}

const api = async (path: string, method = "GET"): Promise<unknown> => {
  const { stdout } = await exec("gh", ["api", "-X", method, path])
  return stdout.trim() ? JSON.parse(stdout) : undefined
}

export const commandGitHub = (repo: string): GitHub => ({
  releaseRuns: async () => {
    const page = (await api(
      `repos/${repo}/actions/workflows/release.yml/runs?branch=main&per_page=30`,
    )) as {
      workflow_runs: {
        id: number
        event: string
        status: string
        created_at: string
        head_sha: string
      }[]
    }
    return page.workflow_runs.map((found) => ({
      id: found.id,
      event: found.event,
      status: found.status,
      createdAt: found.created_at,
      headSha: found.head_sha,
    }))
  },
  jobs: async (runId) => {
    const page = (await api(
      `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    )) as { jobs: Job[] }
    return page.jobs.map(({ name, status }) => ({ name, status }))
  },
  cancel: async (runId) => {
    await api(`repos/${repo}/actions/runs/${runId}/cancel`, "POST")
  },
})

/**
 * Cancels each Release run `newer` supersedes (see `superseded`), reading each run's jobs
 * just before deciding on it. With `dryRun` it only says which it would cancel.
 */
export const supersede = async (
  newer: Newer,
  github: GitHub,
  options: { readonly dryRun?: boolean; readonly log?: (line: string) => void } = {},
): Promise<number[]> => {
  const log = options.log ?? console.log
  const active = (await github.releaseRuns()).filter(
    (found) => found.status !== "completed" && found.status !== "pending",
  )
  if (active.length === 0) log("No Release run holds the group.")
  const decided = await Promise.all(
    active.map(async (found) => {
      const short = found.headSha.slice(0, 9)
      if (!superseded(found, await github.jobs(found.id), newer)) {
        log(`Run ${found.id} (${short}, ${found.event}) is left to finish.`)
        return undefined
      }
      if (options.dryRun) log(`Would cancel run ${found.id} (${short}).`)
      else {
        await github.cancel(found.id)
        log(`Cancelled run ${found.id} (${short}): main has moved past it.`)
      }
      return found.id
    }),
  )
  return decided.filter((id) => id !== undefined)
}

/**
 * `node scripts/release-supersede/main.ts [--dry-run]`: on a push to main, cancels the Release
 * runs of older pushes that are still building, so the newest commit's starts at once.
 * GH_REPO and GH_TOKEN are `gh`'s; GITHUB_SHA and GITHUB_RUN_ID are the push's commit and this
 * run, whose start the older runs are measured against (by hand, now and main's head).
 */
export const main = async (args = process.argv.slice(2)): Promise<void> => {
  const dryRun = args.includes("--dry-run")
  const repo = process.env.GH_REPO
  if (!repo) throw new Error("GH_REPO names the repository, as owner/name.")
  const runId = process.env.GITHUB_RUN_ID
  const createdAt = runId
    ? ((await api(`repos/${repo}/actions/runs/${runId}`)) as { created_at: string }).created_at
    : new Date().toISOString()
  const headSha =
    process.env.GITHUB_SHA ?? ((await api(`repos/${repo}/commits/main`)) as { sha: string }).sha
  await supersede({ headSha, createdAt }, commandGitHub(repo), { dryRun })
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
