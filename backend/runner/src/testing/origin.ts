import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A real repository with a bare origin, and a second clone to land commits on the remote with,
// as a merged pull request does.

/** Runs git as a test would, with an identity. */
export const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  }).trim()

export type Origin = {
  /** The checkout on `main` that tracks origin, its `origin/HEAD` set. */
  readonly repo: string
  /** Commits `file` on the remote's main from another clone; resolves to the new commit. */
  readonly land: (file: string) => string
  /** The remote-tracking main as the checkout last fetched it. */
  readonly fetch: () => void
}

export const withOrigin = (defer: (cleanup: () => void) => void): Origin => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-origin-")))
  defer(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5 }))
  const bare = join(parent, "origin.git")
  mkdirSync(bare)
  gitIn(bare, "init", "--quiet", "--bare", "-b", "main")
  const repo = join(parent, "api")
  gitIn(parent, "clone", "--quiet", bare, repo)
  gitIn(repo, "checkout", "--quiet", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  gitIn(repo, "add", "-A")
  gitIn(repo, "commit", "--quiet", "-m", "first")
  gitIn(repo, "push", "--quiet", "-u", "origin", "main")
  gitIn(repo, "remote", "set-head", "origin", "main")
  const other = join(parent, "other")
  gitIn(parent, "clone", "--quiet", bare, other)
  return {
    repo,
    land: (file) => {
      gitIn(other, "pull", "--quiet", "origin", "main")
      writeFileSync(join(other, file), `${file}\n`)
      gitIn(other, "add", "-A")
      gitIn(other, "commit", "--quiet", "-m", `add ${file}`)
      gitIn(other, "push", "--quiet", "origin", "main")
      return gitIn(other, "rev-parse", "HEAD")
    },
    fetch: () => {
      gitIn(repo, "fetch", "--quiet", "origin")
    },
  }
}
