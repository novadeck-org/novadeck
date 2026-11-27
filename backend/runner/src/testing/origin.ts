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
  /** Commits `file` on the remote's main from another clone, as `message` says; resolves to the new commit. */
  readonly land: (file: string, message?: string) => string
  /** Pushes a new branch with a commit to the remote from another clone, which `repo` has not fetched. */
  readonly branch: (name: string) => string
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
    land: (file, message = `add ${file}`) => {
      gitIn(other, "pull", "--quiet", "origin", "main")
      writeFileSync(join(other, file), `${file}\n`)
      gitIn(other, "add", "-A")
      gitIn(other, "commit", "--quiet", "-m", message)
      gitIn(other, "push", "--quiet", "origin", "main")
      return gitIn(other, "rev-parse", "HEAD")
    },
    branch: (name) => {
      gitIn(other, "pull", "--quiet", "origin", "main")
      gitIn(other, "checkout", "--quiet", "-b", name)
      writeFileSync(join(other, `${name}.txt`), `${name}\n`)
      gitIn(other, "add", "-A")
      gitIn(other, "commit", "--quiet", "-m", `add ${name}`)
      gitIn(other, "push", "--quiet", "origin", name)
      const pushed = gitIn(other, "rev-parse", "HEAD")
      gitIn(other, "checkout", "--quiet", "main")
      return pushed
    },
    fetch: () => {
      gitIn(repo, "fetch", "--quiet", "origin")
    },
  }
}
