// The reporter that records every test that passed only on a retry, so a retry never hides a
// flake: it appends each to the record as the test ends, as a later hang would lose what
// waited for the run's end, and names them all in the log once the run is over.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

import type { Reporter, TestCase, Vitest } from "vitest/node"

import { errorText, recordFolder, type Retried, workspaceRoot } from "./record.js"

/** What marks this reporter among a run's, so a config with several projects adds it once. */
export const marker = Symbol.for("novadeck.retry-record")

/** A package's name, by the package.json at or above a folder. */
const packageName = (folder: string): string => {
  for (let at = folder; ; at = dirname(at)) {
    const manifest = join(at, "package.json")
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { readonly name?: unknown }
      return typeof name === "string" && name !== "" ? name : relative(dirname(at), at)
    }
    if (dirname(at) === at) return folder
  }
}

/** The record entry for a test that ended, or nothing when it didn't pass on a retry. */
export const retriedEntry = (testCase: TestCase, pkg: string): Retried | undefined => {
  const result = testCase.result()
  const { retryCount } = testCase.diagnostic() ?? { retryCount: 0 }
  if (result.state !== "passed" || retryCount < 1) return undefined
  const file = testCase.module.relativeModuleId
  return {
    test: `${file} > ${testCase.fullName}`,
    file,
    package: pkg,
    project: testCase.project.name,
    attempts: retryCount + 1,
    error: errorText(result.errors?.[0]),
  }
}

export class RetryRecord implements Reporter {
  readonly [marker] = true
  readonly #names = new Map<string, string>()
  readonly #recorded: Retried[] = []
  #folder = ""
  #file = ""

  // The record's folder is the workspace's own, unless NOVADECK_RETRY_RECORD names another, as
  // this reporter's tests do.
  onInit(vitest: Vitest): void {
    this.#folder =
      process.env.NOVADECK_RETRY_RECORD || join(workspaceRoot(vitest.config.root), recordFolder)
  }

  onTestCaseResult(testCase: TestCase): void {
    const root = testCase.project.config.root
    const pkg = this.#names.get(root) ?? packageName(root)
    this.#names.set(root, pkg)
    const entry = retriedEntry(testCase, pkg)
    if (!entry) return
    if (!this.#file) {
      mkdirSync(this.#folder, { recursive: true })
      this.#file = join(
        this.#folder,
        `${pkg.replace(/^@/, "").replace(/[^\w.-]+/g, "-")}-${process.pid}.jsonl`,
      )
    }
    appendFileSync(this.#file, `${JSON.stringify(entry)}\n`)
    this.#recorded.push(entry)
  }

  onTestRunEnd(): void {
    if (!this.#recorded.length) return
    const lines = this.#recorded.map(
      (entry) =>
        `  ↻ ${entry.project ? `[${entry.project}] ` : ""}${entry.test} (${entry.attempts} runs): ${entry.error.split("\n")[0]}`,
    )
    const shown = relative(process.cwd(), this.#file)
    console.log(
      [
        "",
        `Passed only on a retry, recorded in ${shown.startsWith("..") ? this.#file : shown}:`,
        ...lines,
        "",
      ].join("\n"),
    )
  }
}
