import { homedir } from "node:os"
import { join } from "node:path"

/** Where agents' worktrees live, one folder per project: `~/.novadeck/worktrees`. */
export const worktreesRoot = (home: string = homedir()): string =>
  join(home, ".novadeck", "worktrees")
