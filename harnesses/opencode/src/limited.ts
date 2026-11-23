import { access, constants } from "node:fs/promises"

import { rulesOf } from "@novadeck/harness-core/conversation"
import type { Harness, Install } from "@novadeck/harness-core/harness"

import { fallbacks } from "./install.js"
import { standing, versionOf } from "./version.js"

// The names opencode's program goes by: its installer's and npm's (`opencode.exe` even off
// Windows, as npm's package links it, probed 2026-11-22, 1.19.6), and npm's shim on Windows.
const names = (platform: NodeJS.Platform): readonly string[] =>
  platform === "win32" ? ["opencode.exe", "opencode.cmd"] : ["opencode"]

const runnable = (path: string): Promise<boolean> =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  )

/**
 * The opencode the person's shells run: the first on their PATH, then where its installers
 * put it (`fallbacks`), as the runner finds a harness; undefined where none is.
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
 * What keeps opencode's messaging from working: a release older than Novadeck's plugin works
 * with, or one of opencode 2, which Novadeck doesn't know yet: either way the plugin loads
 * nothing of Novadeck's (plugin-source.ts), so its sessions don't resume, its messages don't
 * arrive and its chat stays empty.
 */
export const limited: NonNullable<Harness["limited"]> = async (install) => {
  const program = await programOf(install)
  const version = program === undefined ? undefined : await versionOf(program, install.env)
  const known = version === undefined ? "supported" : standing(version)
  return known === "supported" ? undefined : known
}
