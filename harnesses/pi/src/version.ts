import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"

/**
 * The oldest pi this adapter works with. Its screens are the same from 1.0.0, when its TUI went
 * fullscreen, to 1.6.0 (probed 2026-11-24: 1.0.0, 1.3.0, 1.5.2 and 1.6.0, and 1.6.0's own binary,
 * drew every state of a turn alike, `backups/pi-harness-2026-11-24/fixtures-screens/versions`);
 * 0.87.1 drew them inline, in the terminal's own scrollback. Novadeck's extension works from
 * before that (probed 2026-11-24 on 0.99.0, 1.0.0, 1.0.4, 1.1.0, 1.2.0, 1.3.0 and 1.6.0 against a
 * fake model: its tools declared and called, the deliveries at a prompt, a tool call and a Stop, the
 * gate's refusal, an extension's dialog told, `/new` bound again), so its screens set the floor.
 */
export const minimum = "1.0.0"

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
