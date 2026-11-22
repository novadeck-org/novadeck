import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"

/**
 * The oldest opencode this adapter works with, 1.18.0, found by running Novadeck's real plugin and
 * its screens against builds (probed 2026-11-22, a scratch HOME, the e2e fake model, a scripted
 * session of a prompt, a tool, a permission, a question and a subagent):
 *
 * - 1.2.10 (source and binary): the plugin hooks (`config`, `chat.message` with its parts,
 *   `tool.execute.after`) and the events (`permission.asked`/`replied`, `question.asked`/`replied`/
 *   `rejected`, `session.status`/`idle`/`error`) exist, and so does `/global/health`; but the
 *   session ran no question and no subagent report, and its TUI is another layout (a header bar, a
 *   scrollbar, a different footer).
 * - 1.4.0: reports for a prompt, a tool, a permission and a question, none for a subagent, and the
 *   old layout.
 * - 1.15.0: every report of the session, the same dialogs; but the cursor sat elsewhere while a
 *   question showed (row 23 where 1.18.0 and 1.19.x put it at the dialog's end, row 38).
 * - 1.18.0 and 1.19.0 to 1.19.6: every report, and the permission and question dialogs draw the
 *   same, cursor included.
 */
export const minimum = "1.18.0"

/**
 * The first release Novadeck doesn't know: opencode 2 (`@opencode/cli`, 2.3.2 on 2026-11-22,
 * installed by its own script or `opencode upgrade --major`) has a configuration and an API of
 * its own, unprobed here, so the plugin loads nothing of Novadeck's in it, as in one too old.
 */
export const unknownFrom = "2.0.0"

/** What a release is to Novadeck: one it works with, older than that, or newer than it knows. */
export const standing = (version: string): "supported" | "outdated" | "unsupported" =>
  outdated(version) ? "outdated" : outdated(version, unknownFrom) ? "supported" : "unsupported"

const numbers = (version: string): [number, number, number] | undefined => {
  const found = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : undefined
}

/**
 * Whether `version` is older than the `minimum`, by its numbers; false for text that is no
 * version, which says nothing of age.
 */
export const outdated = (version: string, than: string = minimum): boolean => {
  const a = numbers(version)
  const b = numbers(than)
  if (!a || !b) return false
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index]! < b[index]!
  return false
}

// A program's version by its path and modification time: a reinstall in place changes one.
const known = new Map<string, Promise<string | undefined>>()

/**
 * The version of the opencode at `program`, by `opencode --version` (its first line, e.g.
 * `1.19.6`), kept by the path and the file's mtime; undefined where it can't be run or says none.
 * `env` is the environment to run it in.
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
    found = new Promise((resolve) =>
      execFile(program, ["--version"], { env, timeout: 15_000, windowsHide: true }, (error, out) =>
        resolve(error ? undefined : /\d+\.\d+\.\d+\S*/.exec(out)?.[0]),
      ),
    )
    known.set(key, found)
  }
  return found
}
