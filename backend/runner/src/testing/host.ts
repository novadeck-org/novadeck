import { join } from "node:path"

// What an agent session or a Novadeck terminal sets in the environment of everything run in
// it: a test run inside one, as a developer's often is, must not hand them on to a shim, a
// hook or a stand-in, which would read the developer's own terminal and session as theirs.
// Claude Code's path to Git for Windows' bash is the machine's, not a session's.
const session =
  /^(?:NOVADECK_.*|CLAUDECODE|CLAUDE_PID|CLAUDE_CONFIG_DIR|CLAUDE_EFFORT|CLAUDE_CODE_(?!GIT_BASH_PATH$).*|CODEX_.*|CURSOR_VERSION)$/

/** Whether an environment variable is one an agent session or a Novadeck terminal set. */
export const sessionVariable = (name: string): boolean => session.test(name)

/**
 * The environment a test's child runs in: this process's, less what the developer's own
 * agent session or Novadeck terminal set, with `env` over it.
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
