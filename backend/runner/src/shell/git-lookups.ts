import { execFile } from "node:child_process"
import { isAbsolute } from "node:path"

import type { GitLookups } from "@novadeck/harness-core/grants"

import { gitEnv } from "../companions/changes.js"
import { programPath } from "./programs.js"

/** The longest git may take to answer one lookup; past it the call matches nothing. */
export const gitMs = 1_000

// Runs git, found on the PATH by its absolute path (never by name in `cwd`, which the agent
// controls), and gives its output lines, or the exit code of a failure (undefined for a missing
// git or folder, a timeout or a crash).
type Run = { readonly lines: string[] } | { readonly code: number | undefined }
const git = (cwd: string, args: readonly string[]): Promise<Run> =>
  new Promise((resolve) => {
    const program = programPath("git")
    if (program === undefined || !isAbsolute(cwd)) return resolve({ code: undefined })
    execFile(
      program,
      [...args],
      {
        cwd,
        timeout: gitMs,
        maxBuffer: 64 * 1024,
        env: gitEnv(),
        windowsHide: true,
      },
      (error, stdout) => {
        if (!error) return resolve({ lines: stdout.split("\n").filter((line) => line !== "") })
        const code = (error as { code?: unknown }).code
        resolve({ code: typeof code === "number" ? code : undefined })
      },
    )
  })

/**
 * What the matcher reads of git, in the call's own folder: every push URL of a remote
 * (`git remote get-url --push --all`) and the full name a ref resolves to
 * (`git rev-parse --symbolic-full-name`; null for a name that is no ref). A failure, a missing folder or a timeout is
 * undefined, and the matcher then lets nothing through.
 */
export const gitLookups: GitLookups = {
  // A remote name never starts with a dash; one that does would be read as an option.
  pushUrls: async (cwd, remote) => {
    if (remote === "" || remote.startsWith("-")) return undefined
    const run = await git(cwd, ["remote", "get-url", "--push", "--all", remote])
    return "lines" in run ? run.lines : undefined
  },
  // With `-q`, git exits 1 for a name that is no ref: that is an answer (null), not a failure.
  resolve: async (cwd, name) => {
    if (name === "" || name.startsWith("-")) return undefined
    const run = await git(cwd, ["rev-parse", "--symbolic-full-name", "--verify", "-q", name])
    if ("lines" in run) return run.lines.length === 1 ? run.lines[0] : undefined
    return run.code === 1 ? null : undefined
  },
}
