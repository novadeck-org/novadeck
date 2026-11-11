import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"

import { context, describe, expect, it } from "../../test"
import { onCi, retriesFor } from "./policy"
import { errorText, parseRecord, type Retried } from "./record"

const root = join(import.meta.dirname, "..", "..", "..")
const vitest = join(root, "node_modules", "vitest", "vitest.mjs")

const scratch: string[] = []
afterEach(() => {
  for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true })
})

type Run = { readonly status: number | null; readonly output: string; readonly record: Retried[] }

/**
 * A fixture package's tests (fixtures/<name>) through Vitest as CI's scripts run it, with the
 * `--reporter` flags they pass, which replace a config's own reporters. `ci` sets
 * GITHUB_ACTIONS as GitHub does; `fails` is how many runs the flaky test fails first.
 */
const run = (
  fixture: string,
  files: readonly string[],
  {
    ci = true,
    fails = 1,
    suite = "tests",
    env: extra = {},
  }: {
    ci?: boolean
    fails?: number
    suite?: "tests" | "e2e" | "probes"
    env?: Record<string, string>
  } = {},
): Run => {
  const folder = mkdtempSync(join(tmpdir(), "retry-record-"))
  scratch.push(folder)
  const record = join(folder, "record")
  // The outer run's own Vitest settings stay out of the inner one.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("VITEST") && key !== "GITHUB_ACTIONS" && key !== "NODE_ENV",
    ),
  )
  const result = spawnSync(
    process.execPath,
    [vitest, "run", "--reporter=default", "--reporter=hanging-process", ...files],
    {
      cwd: join(import.meta.dirname, "fixtures", fixture),
      encoding: "utf8",
      env: {
        ...env,
        ...(ci ? { GITHUB_ACTIONS: "true" } : {}),
        NOVADECK_RETRY_RECORD: record,
        FIXTURE_STATE: join(folder, "state"),
        FIXTURE_FAILS: String(fails),
        FIXTURE_SUITE: suite,
        NO_COLOR: "1",
        ...extra,
      },
    },
  )
  const entries = existsSync(record)
    ? readdirSync(record).flatMap((file) => parseRecord(readFileSync(join(record, file), "utf8")))
    : []
  return { status: result.status, output: `${result.stdout}${result.stderr}`, record: entries }
}

describe("a test retried on CI", () => {
  context("when it fails once and then passes", () => {
    it("passes the run and is recorded with its first failure", () => {
      const { status, output, record } = run("system", ["flaky"])
      expect(status, output).toBe(0)
      expect(record).toEqual([
        {
          test: "flaky.fixture.ts > a flaky test > fails first, then passes",
          file: "flaky.fixture.ts",
          package: "@fixture/system",
          project: "",
          attempts: 2,
          error: "a loaded runner's failure, run 1",
        },
      ])
      expect(output).toContain("Passed only on a retry, recorded in")
      expect(output).toContain("↻ flaky.fixture.ts > a flaky test > fails first, then passes")
    })

    it("is recorded in every project of a package, extending the root config or not", () => {
      const { status, output, record } = run("projects", [])
      expect(status, output).toBe(0)
      expect(record.map((entry) => [entry.project, entry.attempts]).toSorted()).toEqual([
        ["alone", 2],
        ["extends", 2],
      ])
    })
  })

  context("when it passes the first time", () => {
    it("records nothing", () => {
      const { status, output, record } = run("system", ["steady"])
      expect(status, output).toBe(0)
      expect(record).toEqual([])
      expect(output).not.toContain("Passed only on a retry")
    })
  })

  context("when it always fails", () => {
    it("still fails the run, after its retries, and isn't recorded as passed", () => {
      const { status, output, record } = run("system", ["broken", "steady"])
      expect(status, output).toBe(1)
      expect(output).toContain("always fails")
      expect(output).toMatch(/retry x2/)
      expect(record).toEqual([])
    })
  })

  context("when it fails more often than its retries allow", () => {
    it("fails the run", () => {
      const { status, output, record } = run("system", ["flaky"], { fails: 3 })
      expect(status, output).toBe(1)
      expect(record).toEqual([])
    })
  })

  context("in the end-to-end suite", () => {
    it("runs once more, not twice", () => {
      expect(run("system", ["flaky"], { suite: "e2e" }).record[0]?.attempts).toBe(2)
      const twice = run("system", ["flaky"], { suite: "e2e", fails: 2 })
      expect(twice.status, twice.output).toBe(1)
    })
  })
})

describe("a test that isn't retried", () => {
  context("off CI", () => {
    it("fails the run on its first failure, and nothing is recorded", () => {
      const { status, output, record } = run("system", ["flaky"], { ci: false })
      expect(status, output).toBe(1)
      expect(record).toEqual([])
    })
  })

  context("in a run that counts failures itself (NOVADECK_RETRY=0)", () => {
    it("fails the run on its first failure", () => {
      const { status, output } = run("system", ["flaky"], { env: { NOVADECK_RETRY: "0" } })
      expect(status, output).toBe(1)
    })
  })

  context("in a project its config exempts, as the counter run", () => {
    it("fails the run on its first failure, while the package's other projects retry", () => {
      const { status, output, record } = run("projects", [], { env: { FIXTURE_EXEMPT: "alone" } })
      expect(status, output).toBe(1)
      expect(output).toMatch(/\|alone\|.*fails first, then passes/)
      expect(record.map((entry) => entry.project)).toEqual(["extends"])
    })
  })

  context("in a package that declares itself neutral", () => {
    it("fails the run on its first failure: a pure logic test's failure is a bug", () => {
      const { status, output } = run("neutral", ["flaky"])
      expect(status, output).toBe(1)
    })
  })
})

describe("the retry policy", () => {
  it("retries a browser project's tests whatever its package declares", () => {
    expect(retriesFor({ ci: true, suite: "tests", platform: "neutral", browser: true })).toBe(2)
    expect(retriesFor({ ci: true, suite: "tests", platform: "neutral", browser: false })).toBe(0)
  })

  it("never retries a probe, which records how a harness behaves", () => {
    expect(retriesFor({ ci: true, suite: "probes", platform: "system", browser: false })).toBe(0)
  })

  it("retries nothing off CI, and knows CI by GitHub's own variable", () => {
    expect(retriesFor({ ci: false, suite: "e2e", platform: "system", browser: true })).toBe(0)
    expect(onCi({ GITHUB_ACTIONS: "true" })).toBe(true)
    // The full local run (fulltest.sh) sets CI, and retries nothing.
    expect(onCi({ CI: "true" })).toBe(false)
  })
})

describe("the retry record", () => {
  it("keeps an error's name and cuts a long message", () => {
    expect(errorText({ name: "AssertionError", message: "expected 1 to be 2" })).toBe(
      "AssertionError: expected 1 to be 2",
    )
    expect(errorText({ name: "Error", message: "plain" })).toBe("plain")
    expect(errorText(undefined)).toBe("(no message)")
    expect(errorText({ message: "x".repeat(5000) })).toHaveLength(1000)
  })

  it("refuses a line that isn't a retried test, as a corrupt record would hide one", () => {
    expect(() => parseRecord("not json\n")).toThrow(/isn't JSON/)
    expect(() =>
      parseRecord(
        `${JSON.stringify({ test: "a > b", file: "a", package: "p", project: "", attempts: 1, error: "e" })}\n`,
      ),
    ).toThrow(/isn't a retried test/)
    expect(parseRecord("\n")).toEqual([])
  })
})
