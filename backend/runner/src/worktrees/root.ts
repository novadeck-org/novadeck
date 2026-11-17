import { homedir } from "node:os"
import { join } from "node:path"

import { samePath } from "@novadeck/harness-core/paths"

/** Where agents' worktrees live, one folder per project: `~/.novadeck/worktrees`. */
export const worktreesRoot = (home: string = homedir()): string =>
  join(home, ".novadeck", "worktrees")

/**
 * A session's saved folder, unless it is the bare folder of agents' worktrees, `root`, where no
 * agent works, its worktrees being below it: then none, and the terminal's folder stands in.
 * An Antigravity session saved before its decoder left out the folders its process was given
 * with `--add-dir` may carry that folder.
 */
export const sessionFolder = (
  saved: string | undefined,
  root: string | undefined,
): string | undefined =>
  saved !== undefined && root !== undefined && samePath(saved, root) ? undefined : saved
