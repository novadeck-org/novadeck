import { join } from "node:path"

import { hookVariables } from "../shell/hook.js"
import { inherited } from "../shell/inherited.js"

/**
 * What a Novadeck terminal or an agent session sets in the environment of everything run in
 * it, which a test run inside one, as a developer's often is, must not hand on to a shim, a
 * hook or a stand-in: they would read the developer's own terminal and session as theirs.
 * Those Novadeck itself keeps from what it starts (`inherited`), what its relay reads of a hook's
 * agent (`hookVariables`), and the harnesses' config homes, which would point a stand-in at the
 * developer's own.
 */
export const hostVariables: readonly string[] = [
  ...new Set([...inherited, ...hookVariables, "CODEX_HOME", "CLAUDE_CONFIG_DIR"]),
]

/**
 * Whether an environment variable is one of `hostVariables`. On Windows names have no case,
 * as `stripInherited` takes them.
 */
export const sessionVariable = (
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean =>
  platform === "win32"
    ? hostVariables.some((each) => each.toUpperCase() === name.toUpperCase())
    : hostVariables.includes(name)

/**
 * The environment a test's child runs in: this process's, less what the developer's own
 * agent session or Novadeck terminal set (`hostVariables`), with `env` over it.
 */
export const hostless = (env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !sessionVariable(name))),
  ...env,
})

/**
 * Options for `installShellFiles` that keep the person's own home out of the files it
 * writes: a worktrees folder and a Codex config of the test's own, under `root`, neither
 * there until the test makes it. By default it would pass on `~/.novadeck/worktrees` and
 * `~/.codex/config.toml`'s writable roots.
 */
export const ownHome = (root: string) => ({
  worktrees: join(root, "home", ".novadeck", "worktrees"),
  codexConfig: join(root, "home", ".codex", "config.toml"),
})
