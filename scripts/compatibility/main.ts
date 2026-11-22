import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

import { judgeContract, type Finding, type Verdict } from "../../contract/protocol/src/compare.ts"
import type { ContractSnapshot } from "../../contract/protocol/src/snapshot.ts"
import { newestRelease } from "../release-notes/sources.ts"

const run = promisify(execFile)

/** Where the contract is kept, as the protocol's test writes it, in a release and here. */
export const contractPath = "contract/protocol/contract.json"

const usage = "Usage: main.ts [--base <ref>]"

/** What the check reads from outside, behind functions so tests run without a repository. */
export type Sources = {
  /** The ref of the newest release reachable from HEAD, or `undefined` before there is one. */
  readonly newest: () => Promise<string | undefined>
  /** `contract.json` as `ref` has it, or `undefined` when it has none. */
  readonly released: (ref: string) => Promise<string | undefined>
  /** `contract.json` as the working tree has it. */
  readonly current: () => Promise<string>
}

/** Git and the working tree in `cwd` (the current directory when `undefined`). */
export const gitSources = (cwd?: string): Sources => ({
  newest: async () => (await newestRelease(cwd))?.ref,
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
  ref: string,
  before: ContractSnapshot,
  after: ContractSnapshot,
  { findings, gated, problems }: Verdict,
): string => {
  const ui = findings.filter((finding) => finding.behind === "ui")
  const runner = findings.filter((finding) => finding.behind === "runner")
  const was = before.revision
  return [
    `Contract compared with ${ref}, at revision ${was}.`,
    `This build: revision ${after.revision}; it serves UIs from ${after.oldestClient} and works with runners from ${after.oldestRunner}.`,
    ...(ui.length > 0
      ? [`Leaves UIs of revision ${was} behind (oldestClient):`, ...listed(ui)]
      : []),
    ...(runner.length > 0
      ? [`Leaves runners of revision ${was} behind (oldestRunner):`, ...listed(runner)]
      : []),
    ...(gated.length > 0 ? [`New, for UIs to ask for (since): ${gated.join(", ")}`] : []),
    ...(problems.length > 0
      ? ["", "Failed:", ...problems.map((problem) => `  - ${problem}`)]
      : ["", findings.length > 0 ? "Passed: each change moved its side's edge." : "Passed."]),
  ].join("\n")
}

/**
 * `node scripts/compatibility/main.ts [--base <ref>]`: compares `contract.json` with the newest
 * release's (or `ref`'s), and fails when the window doesn't fit what changed since
 * (`judgeContract`). Before any release holds a contract.json, there's nothing to compare.
 * Resolves the exit code.
 */
export const main = async (
  args: readonly string[] = process.argv.slice(2),
  sources: Sources = gitSources(),
  log: (line: string) => void = console.log,
): Promise<number> => {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--base")) throw new Error(usage)
  const ref = args[1] ?? (await sources.newest())
  if (ref === undefined) {
    log("No release yet: there is no contract to compare with.")
    return 0
  }
  const released = await sources.released(ref)
  if (released === undefined) {
    log(`${ref} has no ${contractPath}: the first release that has one is the baseline.`)
    return 0
  }
  const before = JSON.parse(released) as ContractSnapshot
  const after = JSON.parse(await sources.current()) as ContractSnapshot
  const verdict = judgeContract(before, after)
  log(report(ref, before, after, verdict))
  return verdict.problems.length > 0 ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
