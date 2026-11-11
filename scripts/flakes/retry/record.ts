// The record of tests that passed only on a retry: one JSON object a line, appended by the
// reporter as each such test ends, uploaded by CI's test and E2E jobs, and read by Known
// Flakes. A run that passed with retries is green, so this record is where its flakes show.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** A test that failed, was run again, and passed. */
export type Retried = {
  // The test as the register and Vitest's FAIL lines name it: "file > describe > ... > it".
  readonly test: string
  // Its file, from its package's folder.
  readonly file: string
  // Its package's name, and the Vitest project it ran in ("" with none).
  readonly package: string
  readonly project: string
  // How many times it ran, the passing run included: 2 or more.
  readonly attempts: number
  // The first failure's error, as "Name: message", cut to `errorLength`.
  readonly error: string
}

export const errorLength = 1000

/** Where the record is written, from the workspace's root: CI uploads this folder. */
export const recordFolder = join("test-results", "retried")

/** The workspace root above a folder, by its pnpm-workspace.yaml, or the folder itself. */
export const workspaceRoot = (folder: string): string => {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, "pnpm-workspace.yaml"))) return at
    if (dirname(at) === at) return folder
  }
}

// A terminal's escape sequences, as Vitest colours an assertion's message even on CI.
// oxlint-disable-next-line no-control-regex -- Escape sequences are what this removes.
const escapes = /\u001b\[[\d;?]*[A-Za-z]/g

/** Text with its terminal colours and other escape sequences taken out. */
export const withoutColour = (text: string): string => text.replaceAll(escapes, "")

/** The first failure's error as the record keeps it: plain text, without its colours. */
export const errorText = (error: { readonly name?: string; readonly message?: string } = {}) => {
  const name = error.name && error.name !== "Error" ? `${error.name}: ` : ""
  const text = withoutColour(`${name}${error.message ?? "(no message)"}`)
  return text.length > errorLength ? `${text.slice(0, errorLength - 1)}…` : text
}

const isRetried = (value: unknown): value is Retried => {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    ["test", "file", "package", "error"].every(
      (key) => typeof entry[key] === "string" && entry[key] !== "",
    ) &&
    typeof entry.project === "string" &&
    Number.isInteger(entry.attempts) &&
    (entry.attempts as number) >= 2
  )
}

/**
 * A record file's lines, failing on one that isn't a retried test, as a corrupt record would
 * hide one. An error a record from before `errorText` took the colours out still holds them
 * loses them here, so every reader sees the same text.
 */
export const parseRecord = (text: string): Retried[] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`Line ${index + 1} of the retry record isn't JSON: ${line}`)
      }
      if (!isRetried(value))
        throw new Error(`Line ${index + 1} of the retry record isn't a retried test: ${line}`)
      return { ...value, error: withoutColour(value.error) }
    })

/** A record file, read. */
export const readRecordFile = (path: string): Retried[] => parseRecord(readFileSync(path, "utf8"))
