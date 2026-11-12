import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "../../test"

// Quality's and E2E's jobs set up through .github/actions/setup, as Nightly Quality has since
// #842: the toolchain with its wait and retry, and what a job asks for besides. These hold that
// every job that set its toolchain up inline still gets it, and the rest it ran.

const root = join(import.meta.dirname, "..", "..", "..")
// Its line endings as written: Windows' checkout gives the actions CRLF, which the tests'
// line-by-line matches would then miss.
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n")

/** A workflow's top-level jobs, by id, each with its text. */
const jobsOf = (workflow: string): Map<string, string> => {
  const body = workflow.slice(workflow.indexOf("\njobs:\n"))
  const jobs = new Map<string, string>()
  const starts = [...body.matchAll(/\n {2}([a-z][\w-]*):\n/g)]
  starts.forEach((match, index) =>
    jobs.set(match[1]!, body.slice(match.index, starts[index + 1]?.index ?? body.length)),
  )
  return jobs
}

const setUp = "uses: ./.github/actions/setup"

describe("the workflows' setup", () => {
  const workflows = ["quality", "e2e"].map(
    (name) => [name, read(`.github/workflows/${name}.yml`)] as const,
  )

  it.each(workflows)("leaves %s no toolchain set up inline", (_name, workflow) => {
    expect(workflow).not.toContain("pnpm/setup@")
    expect(workflow).not.toContain("Set Up Toolchain")
  })

  // A job that checks the repository out runs pnpm or node after: it sets up through the
  // action, after its checkout, which the action is read from. A job that takes another's
  // steps (`steps: *steps`) has them from that job.
  it.each(workflows)(
    "sets every job of %s up through the action, after its checkout",
    (_name, workflow) => {
      const jobs = jobsOf(workflow)
      const anchored = [...jobs.values()].filter((job) => /\n {4}steps: \*[\w-]+\n/.test(job))
      const own = [...jobs.entries()].filter(([, job]) => job.includes("actions/checkout@"))
      expect(own.length).toBeGreaterThan(0)
      for (const [id, job] of own) {
        expect(job, id).toContain(setUp)
        expect(job.indexOf(setUp), id).toBeGreaterThan(job.indexOf("actions/checkout@"))
      }
      for (const job of anchored) {
        const anchor = /\n {4}steps: \*([\w-]+)\n/.exec(job)![1]!
        expect(workflow).toContain(`steps: &${anchor}`)
        const source = [...jobs.values()].find((each) => each.includes(`steps: &${anchor}`))!
        expect(source).toContain(setUp)
      }
    },
  )

  // Package's job checks out the source it packages, a pull request's head or a release's
  // `source_sha`, and would read the action from there: a rerun or a promotion of a source from
  // before #842 would fail in its setup, on the path to the pilot user's releases. It keeps its
  // setup inline until it reads the action from the workflow's own commit (`github.workflow_sha`).
  it("leaves Package's setup inline, as it checks out the source it packages", () => {
    const pkg = read(".github/workflows/package.yml")
    expect(pkg).toContain("ref: ${{ github.event.pull_request.head.sha || inputs.source_sha }}")
    expect(pkg).not.toContain(setUp)
    expect(pkg).toContain("pnpm/setup@")
  })

  it("gives Quality's test rows what each asks for, the relay's Rust for every row", () => {
    const quality = jobsOf(read(".github/workflows/quality.yml")).get("quality")!
    const step = quality.slice(
      quality.indexOf("- name: Set Up\n"),
      quality.indexOf("\n\n", quality.indexOf(setUp)),
    )
    expect(step).toContain("id: setup")
    expect(step).toContain("rust: true")
    expect(step).toContain("browser: ${{ matrix.browser || false }}")
    expect(step).toContain("electron: ${{ matrix.electron || false }}")
    expect(step).toContain("fish: ${{ matrix.shard == 1 }}")
  })

  it("has Quality save the relay's build under the action's key, only where it wasn't restored", () => {
    const quality = jobsOf(read(".github/workflows/quality.yml")).get("quality")!
    expect(quality).toContain(
      "if: ${{ !cancelled() && steps.relay-build.outcome == 'success' && steps.setup.outputs.rust-cache-hit != 'true' }}",
    )
    expect(quality).toContain("key: ${{ steps.setup.outputs.rust-key }}")
    expect(quality).toContain(
      "NOVADECK_REQUIRE_FISH: ${{ steps.setup.outputs.fish == 'true' && '1' || '' }}",
    )
  })

  it("is an action that takes what the workflows pass and gives what they read", () => {
    const action = read(".github/actions/setup/action.yml")
    // Its top-level sections, each up to the next.
    const section = (name: string, next: string) =>
      action.slice(action.indexOf(`\n${name}:\n`), action.indexOf(`\n${next}:\n`))
    for (const input of ["rust", "browser", "electron", "fish"])
      expect(section("inputs", "outputs")).toContain(`\n  ${input}:\n`)
    for (const output of ["rust-key", "rust-cache-hit", "fish"])
      expect(section("outputs", "runs")).toContain(`\n  ${output}:\n`)
    expect(action.slice(action.indexOf("\nruns:\n"))).toContain("using: composite")
  })
})
