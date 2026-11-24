import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"

/**
 * The oldest pi this adapter works with. 1.1.0 is a floor read from its changelog
 * (`registerTool`'s model-only exposure, `agent_before_settle`, `agent_settled`, `ui_prompt_start`,
 * `--session-id`), to be confirmed by running older builds.
 */
export const minimum = "1.1.0"

/** The first release Novadeck doesn't know: pi 2. */
export const unknownFrom = "2.0.0"

/** What a release is to Novadeck: one it works with, older than that, or newer than it knows. */
export const standing = (version: string): "supported" | "outdated" | "unsupported" =>
  outdated(version) ? "outdated" : outdated(version, unknownFrom) ? "supported" : "unsupported"

const numbers = (version: string): [number, number, number] | undefined => {
  const found = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : undefined
}

/** Whether `version` is older than `than`, by its numbers; false for text that is no version. */
export const outdated = (version: string, than: string = minimum): boolean => {
  const a = numbers(version)
  const b = numbers(than)
  if (!a || !b) return false
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index]! < b[index]!
  return false
}

const known = new Map<string, Promise<string | undefined>>()

/**
 * The version of the pi at `program`, by `pi --version` alone (a bare semver on its first line):
 * `--help` writes into `~/.pi`, and Ubuntu's apt `pi` prints digits of π, so only a line that is a
 * version counts. Kept by the path and the file's mtime; undefined where it can't be run.
 */
export const versionOf = async (
  program: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> => {
  const modified = await stat(program).then(
    (file) => file.mtimeMs,
    () => undefined,
  )
  if (modified === undefined) return undefined
  const key = `${program}\0${modified}`
  let found = known.get(key)
  if (!found) {
    const batch = /\.(?:cmd|bat)$/i.test(program)
    found = new Promise((resolve) =>
      execFile(
        batch ? `"${program}"` : program,
        ["--version"],
        { env, timeout: 15_000, windowsHide: true, ...(batch && { shell: true }) },
        (error, out) =>
          resolve(
            error ? undefined : /^\d+\.\d+\.\d+\S*$/.exec(out.trim().split(/\r?\n/)[0] ?? "")?.[0],
          ),
      ),
    )
    known.set(key, found)
  }
  return found
}
