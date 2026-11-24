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
 * The pi the person's shells run: the first on their PATH, then where its installers put it
 * (`fallbacks`); undefined where none is.
 */
export const programOf = async (install: Install): Promise<string | undefined> => {
  const rules = rulesOf(install)
  const path = install.env.PATH ?? install.env.Path ?? ""
  const folders = path.split(install.platform === "win32" ? ";" : ":").filter(Boolean)
  const candidates = [
    ...folders.flatMap((folder) => names(install.platform).map((name) => rules.join(folder, name))),
    ...(fallbacks(install) ?? []),
  ]
  for (const candidate of candidates)
    // eslint-disable-next-line no-await-in-loop -- The first that runs answers.
    if (await runnable(candidate)) return candidate
  return undefined
}

/**
 * What keeps pi's messaging from working: a release older than Novadeck's extension works with,
 * or one of pi 2, which Novadeck doesn't know yet.
 */
export const limited: NonNullable<Harness["limited"]> = async (install) => {
  const program = await programOf(install)
  const version = program === undefined ? undefined : await versionOf(program, install.env)
  const known = version === undefined ? "supported" : standing(version)
  return known === "supported" ? undefined : known
}
