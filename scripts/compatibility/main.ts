import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

import {
  judgeReleases,
  type Finding,
  type Release,
  type WindowVerdict,
} from "../../contract/protocol/src/compare.ts"
import type { ContractSnapshot } from "../../contract/protocol/src/snapshot.ts"
import { markerPrefix } from "../release-notes/sources.ts"

const run = promisify(execFile)

/** Where the contract is kept, as the protocol's test writes it, in a release and here. */
export const contractPath = "contract/protocol/contract.json"

const usage = "Usage: main.ts [--base <ref>] [--peer <ref>]"

// `--base` and `--peer`, each at most once, with its ref.
const parsed = (args: readonly string[]): { readonly base?: string; readonly peer?: string } => {
  const given: { base?: string; peer?: string } = {}
  for (let at = 0; at < args.length; at += 2) {
    const [flag, ref] = [args[at], args[at + 1]]
    const name = flag === "--base" ? "base" : flag === "--peer" ? "peer" : undefined
    if (name === undefined || !ref || ref.startsWith("--") || name in given) throw new Error(usage)
    given[name] = ref
  }
  return given
}

/** What the check reads from outside, behind functions so tests run without a repository. */
export type Sources = {
  /**
   * The refs of the releases reachable from HEAD, newest first: a `vX.Y.Z` tag, or the
   * `release-base/vX.Y.Z` marker that stands in for one history was rewritten away from.
   */
  readonly releases: () => Promise<readonly string[]>
  /** `contract.json` as `ref` has it, or `undefined` when it has none. */
  readonly released: (ref: string) => Promise<string | undefined>
  /** `contract.json` as the working tree has it. */
  readonly current: () => Promise<string>
}

/** Git and the working tree in `cwd` (the current directory when `undefined`). */
export const gitSources = (cwd?: string): Sources => ({
  releases: async () => {
    const { stdout } = await run(
      "git",
      ["tag", "--merged", "HEAD", "--list", "v*.*.*", `${markerPrefix}v*.*.*`],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    )
    const versioned = stdout.split("\n").flatMap((ref) => {
      const parts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(ref.replace(markerPrefix, ""))
      return parts ? [{ ref, parts: parts.slice(1).map(Number) }] : []
    })
    return versioned
      .toSorted((a, b) => b.parts.reduce((diff, part, at) => diff || part - a.parts[at]!, 0))
      .map(({ ref }) => ref)
  },
  released: async (ref) => {
    try {
      const { stdout } = await run("git", ["show", `${ref}:${contractPath}`], {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
      })
      return stdout
    } catch (error) {
      // A release from before contract.json, which only `git show` tells apart from others.
      const said = String((error as { stderr?: unknown }).stderr ?? "")
      if (/does not exist in|exists on disk, but not in/.test(said)) return undefined
      throw error
    }
  },
  current: () => readFile(cwd === undefined ? contractPath : `${cwd}/${contractPath}`, "utf8"),
})

const listed = (findings: readonly Finding[]): string[] =>
  findings.map(
    ({ procedure, at, reason }) => `  ${[procedure, at].filter(Boolean).join(" ")}: ${reason}`,
  )

/** The verdict as the check prints it: what changed for each side, then what's wrong. */
export const report = (
  releases: readonly Release[],
  after: ContractSnapshot,
  { findings, gated, problems, older }: WindowVerdict,
): string => {
  const [newest] = releases
  const ui = findings.filter((finding) => finding.behind === "ui")
  const runner = findings.filter((finding) => finding.behind === "runner")
  const was = newest?.contract.revision ?? 0
  const others = releases.length - 1
  return [
    `Contract compared with ${newest?.ref}, at revision ${was}${others > 0 ? `, and ${others} older release(s) still in the window` : ""}.`,
    `This build: revision ${after.revision}; it serves UIs from ${after.oldestClient} and works with runners from ${after.oldestRunner}.`,
    ...(ui.length > 0
      ? [`Leaves UIs of revision ${was} behind (oldestClient):`, ...listed(ui)]
      : []),
    ...(runner.length > 0
      ? [`Leaves runners of revision ${was} behind (oldestRunner):`, ...listed(runner)]
      : []),
    ...(gated.length > 0 ? [`New, for UIs to ask for (since): ${gated.join(", ")}`] : []),
    ...older.flatMap(({ ref, revision, findings: left }) => [
      `Leaves peers of ${ref} (revision ${revision}) behind:`,
      ...listed(left),
    ]),
    ...(problems.length > 0
      ? ["", "Failed:", ...problems.map((problem) => `  - ${problem}`)]
      : ["", findings.length > 0 ? "Passed: each change moved its side's edge." : "Passed."]),
  ].join("\n")
}

// Releases read at most, newest first: far more than a window spans.
const mostReleases = 400

/**
 * The releases to compare with, newest first: each still in `after`'s window, one per
 * revision (a release whose contract didn't change kept its revision), down to the first
 * without a contract.json.
 */
const inWindow = async (
  refs: readonly string[],
  after: ContractSnapshot,
  sources: Sources,
): Promise<Release[]> => {
  const oldest = Math.min(after.oldestClient, after.oldestRunner)
  const releases: Release[] = []
  for (const ref of refs.slice(0, mostReleases)) {
    // eslint-disable-next-line no-await-in-loop -- Newest first, until the window ends.
    const text = await sources.released(ref)
    if (text === undefined) break
    const contract = JSON.parse(text) as ContractSnapshot
    if (releases.length > 0 && contract.revision < oldest) break
    if (releases.at(-1)?.contract.revision !== contract.revision) releases.push({ ref, contract })
  }
  return releases
}

/**
 * `node scripts/compatibility/main.ts [--base <ref>] [--peer <ref>]`: compares `contract.json`
 * with the newest release's, and with each older one still in the window (or with `--base`'s
 * alone), and fails when the window doesn't fit what changed (`judgeReleases`). Before any
 * release holds a contract.json, there's nothing to compare.
 *
 * `--peer` names a contract the next release ships though no release holds it yet, as a pull
 * request's base: merged, and not released yet. It's judged too, as the newest release's is,
 * so a change that fits the releases but leaves the base's peers behind fails here, not at the
 * release once merged. Resolves the exit code.
 */
export const main = async (
  args: readonly string[] = process.argv.slice(2),
  sources: Sources = gitSources(),
  log: (line: string) => void = console.log,
): Promise<number> => {
  const { base, peer } = parsed(args)
  const refs = base === undefined ? await sources.releases() : [base]
  const [newest] = refs
  const after = JSON.parse(await sources.current()) as ContractSnapshot
  const releases = newest === undefined ? [] : await inWindow(refs, after, sources)
  let failed = false
  if (releases.length > 0) {
    const verdict = judgeReleases(releases, after)
    log(report(releases, after, verdict))
    failed = verdict.problems.length > 0
  } else if (newest === undefined) log("No release yet: there is no contract to compare with.")
  else log(`${newest} has no ${contractPath}: the first release that has one is the baseline.`)
  if (peer === undefined) return failed ? 1 : 0
  const held = await sources.released(peer)
  if (held === undefined) {
    log(`${peer} has no ${contractPath}: nothing more to compare with.`)
    return failed ? 1 : 0
  }
  const pending: Release = { ref: peer, contract: JSON.parse(held) as ContractSnapshot }
  const [released] = releases
  if (released && JSON.stringify(released.contract) === JSON.stringify(pending.contract)) {
    log(`${peer} holds ${released.ref}'s contract: nothing more to compare.`)
    return failed ? 1 : 0
  }
  const verdict = judgeReleases([pending], after)
  log("")
  log(report([pending], after, verdict))
  return failed || verdict.problems.length > 0 ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
