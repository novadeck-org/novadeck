import { execFile } from "node:child_process"
import { isAbsolute } from "node:path"

import type { GitLookups } from "@novadeck/harness-core/grants"

/** The longest git may take to tell a remote's push URLs; past it the call matches nothing. */
export const gitMs = 1_000

/**
 * What the matcher reads of git, in the call's own folder: every push URL of a remote
 * (`git remote get-url --push --all`). A failure, a missing folder or a timeout is
 * undefined, and the matcher then lets nothing through.
 */
export const gitLookups: GitLookups = {
  pushUrls: (cwd, remote) =>
    new Promise((resolve) => {
      // A remote name never starts with a dash; one that does would be read as an option.
      if (!isAbsolute(cwd) || remote === "" || remote.startsWith("-")) return resolve(undefined)
      execFile(
        "git",
        ["remote", "get-url", "--push", "--all", remote],
        {
          cwd,
          timeout: gitMs,
          maxBuffer: 64 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
          },
          windowsHide: true,
        },
        (error, stdout) =>
          resolve(error ? undefined : stdout.split("\n").filter((line) => line !== "")),
      )
    }),
}
