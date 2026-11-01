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
type Run = { readonly out: string } | { readonly code: number | undefined }
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
        if (!error) return resolve({ out: stdout })
        const code = (error as { code?: unknown }).code
        resolve({ code: typeof code === "number" ? code : undefined })
      },
    )
  })

const lines = (out: string): string[] => out.split("\n").filter((line) => line !== "")

/**
 * `url` as `git push <url>` reads it: the configuration's `url.<base>.pushInsteadOf` rewrites
 * it when one of its values starts it, else `url.<base>.insteadOf` does; the longest matching
 * value wins, as in git's own `alias_url`. `entries` is `git config --null --get-regexp` of
 * those keys: `key\nvalue\0` each. Undefined for a rule git reads as matching every URL (an
 * empty value) or without a value, which are not modelled: the caller refuses.
 */
export const rewrittenPushUrl = (url: string, entries: string): string | undefined => {
  const best = { push: { length: -1, base: "" }, fetch: { length: -1, base: "" } }
  for (const entry of entries.split("\0")) {
    if (entry === "") continue
    const newline = entry.indexOf("\n")
    const key = newline < 0 ? entry : entry.slice(0, newline)
    const prefix = newline < 0 ? "" : entry.slice(newline + 1)
    const dot = key.lastIndexOf(".")
    if (!key.toLowerCase().startsWith("url.") || dot <= 3) continue
    if (prefix === "") return undefined
    const kind = key.slice(dot + 1).toLowerCase()
    const found =
      kind === "pushinsteadof" ? best.push : kind === "insteadof" ? best.fetch : undefined
    if (found && url.startsWith(prefix) && prefix.length > found.length) {
      found.length = prefix.length
      found.base = key.slice(4, dot)
    }
  }
  const use = best.push.length >= 0 ? best.push : best.fetch
  return use.length < 0 ? url : use.base + url.slice(use.length)
}

/**
 * What the matcher reads of git, in the call's own folder: every push URL of a remote
 * (`git remote get-url --push --all`) and the full name a ref resolves to
 * (`git rev-parse --symbolic-full-name`; null for a name that is no ref), and where a URL
 * pushes to. A failure, a missing folder or a timeout is
 * undefined, and the matcher then lets nothing through.
 */
export const gitLookups: GitLookups = {
  // A remote name never starts with a dash; one that does would be read as an option.
  pushUrls: async (cwd, remote) => {
    if (remote === "" || remote.startsWith("-")) return undefined
    const run = await git(cwd, ["remote", "get-url", "--push", "--all", remote])
    return "out" in run ? lines(run.out) : undefined
  },
  // With `-q`, git exits 1 for a name that is no ref: that is an answer (null), not a failure.
  resolve: async (cwd, name) => {
    if (name === "" || name.startsWith("-")) return undefined
    const run = await git(cwd, ["rev-parse", "--symbolic-full-name", "--verify", "-q", name])
    if ("out" in run) return lines(run.out).length === 1 ? lines(run.out)[0] : undefined
    return run.code === 1 ? null : undefined
  },
  // A remote section named like the URL (`remote.<url>.url`/`.pushurl`) is what `git push <url>`
  // pushes to; with none (exit 2) the URL goes through the configuration's rewrites.
  pushTarget: async (cwd, url) => {
    if (url === "" || url.startsWith("-")) return undefined
    const named = await git(cwd, ["remote", "get-url", "--push", "--all", url])
    if ("out" in named) return lines(named.out)
    if (named.code !== 2) return undefined
    const run = await git(cwd, [
      "config",
      "--null",
      "--get-regexp",
      "^url\\..*\\.(insteadof|pushinsteadof)$",
    ])
    const target = "out" in run ? rewrittenPushUrl(url, run.out) : run.code === 1 ? url : undefined
    return target === undefined ? undefined : [target]
  },
}
