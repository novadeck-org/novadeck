import { access, constants } from "node:fs/promises"

import { rulesOf } from "@novadeck/harness-core/conversation"
import type { Harness, Install } from "@novadeck/harness-core/harness"

import { fallbacks } from "./install.js"
import { standing, versionOf } from "./version.js"

// The names pi's program goes by: npm's and the installer's launchers, and npm's shims on Windows.
const names = (platform: NodeJS.Platform): readonly string[] =>
  platform === "win32" ? ["pi.exe", "pi.cmd"] : ["pi"]

const runnable = (path: string): Promise<boolean> =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  )

/**
 * The pi the person's shells run, and its version: the first on their PATH, then where its
 * installers put it (`fallbacks`), that answers `--version` with one. Another program named `pi`
 * (Ubuntu's prints digits of π) answers with none and is passed over. Undefined where no pi is.
 */
export const programOf = async (
  install: Install,
): Promise<{ readonly program: string; readonly version: string } | undefined> => {
  const rules = rulesOf(install)
  const path = install.env.PATH ?? install.env.Path ?? ""
  const folders = path.split(install.platform === "win32" ? ";" : ":").filter(Boolean)
  const candidates = [
    ...folders.flatMap((folder) => names(install.platform).map((name) => rules.join(folder, name))),
    ...(fallbacks(install) ?? []),
  ]
  for (const program of new Set(candidates)) {
    // eslint-disable-next-line no-await-in-loop -- The first that runs answers.
    if (!(await runnable(program))) continue
    // eslint-disable-next-line no-await-in-loop -- As above.
    const version = await versionOf(program, install.env)
    if (version !== undefined) return { program, version }
  }
  return undefined
}

/**
 * What keeps pi's messaging from working: a release older than Novadeck's extension works with,
 * or one of pi 2, which Novadeck doesn't know yet.
 */
export const limited: NonNullable<Harness["limited"]> = async (install) => {
  const found = await programOf(install)
  const known = found === undefined ? "supported" : standing(found.version)
  return known === "supported" ? undefined : known
}
