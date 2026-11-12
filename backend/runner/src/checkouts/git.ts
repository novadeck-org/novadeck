import { AsyncLocalStorage } from "node:async_hooks"
import { spawn } from "node:child_process"
import { statSync } from "node:fs"

import { hiddenCharacter } from "@novadeck/protocol"

import { gitEnv, gitPath } from "../git.js"
import { killTree } from "../programs.js"
import { ellipsized } from "../text.js"

// Git, run for what a checkout holds: the Changes panel's works, the changes item's layers and
// the snapshots both read.

/**
 * A signal that ends the git runs started while it is in scope (a reader closing): they are
 * killed and fail, and nothing waits on them.
 */
export const gitScope = new AsyncLocalStorage<AbortSignal>()

/** How long one git run may take (a test shortens it), and how much of its output is kept. */
export const timing = {
  gitMs: 5_000,
  /** A read slower than this makes the next wait longer (a test shortens it). */
  slowMs: 1_000,
  /** Called with the arguments of each git run (a test looks at them). */
  saw: undefined as ((args: readonly string[]) => void) | undefined,
}
export type Run =
  | { readonly ok: true; readonly out: string; readonly cut: boolean }
  | {
      readonly ok: false
      readonly kind: "no-git" | "timeout" | "big" | "exit"
      readonly status: number
      readonly said: string
      /** What it printed before it failed, where it did (a `merge-tree` that conflicts). */
      readonly out?: string
    }

// What git said, as one line without invisible characters.
const hidden = new RegExp(hiddenCharacter.source, "gu")
const oneLine = (text: string, max: number): string => {
  const line = text.replaceAll(hidden, " ").replaceAll(/\s+/g, " ").trim()
  return ellipsized(line, max, false)
}

// Runs git as the person would, with no shell, a fixed argument list and the environment
// above. Switched off: a repository's file monitor hook program (git's own monitor stays,
// as `limit.monitor` says), external diff programs, text conversion, a pager and prompts. Not switched off: clean filters (git-lfs, say) of
// files whose stat changed, which run as in the person's own `git diff`. Output past
// `cap` bytes ends the run: it is `cut` where `truncate`, else a failure. `env` adds
// variables to the run (a private index file, an identity to commit as).
export const git = (
  cwd: string,
  args: readonly string[],
  limit: {
    readonly cap: number
    readonly truncate?: boolean
    readonly monitor?: boolean
    readonly env?: NodeJS.ProcessEnv
    /** Text written to its standard input (a list of paths, say). */
    readonly input?: string
    /** How long it may take, where that is more than `timing.gitMs`. */
    readonly ms?: number
    /**
     * On a timeout, ask git to stop (SIGTERM, so it removes the lock files it holds) and kill
     * it only after this many milliseconds. Windows has no graceful stop for a process tree
     * here, so there it is ended at once, which is why callers keep `ms` generous.
     */
    readonly graceMs?: number
  },
): Promise<Run> =>
  new Promise((done) => {
    const program = gitPath()
    if (!program) return done({ ok: false, kind: "no-git", status: 0, said: "" })
    let settled = false
    const scope = gitScope.getStore()
    let timedOut = false
    let hard: ReturnType<typeof setTimeout> | undefined
    const finish = (run: Run) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hard)
      scope?.removeEventListener("abort", ended)
      done(run)
    }
    const ended = () => {
      killTree(child.pid)
      finish({ ok: false, kind: "exit", status: -1, said: "Novadeck is closing." })
    }
    const full = [
      "-c",
      "core.quotepath=off",
      // A hook program named by the repository's config never runs; git's own monitor
      // (`core.fsmonitor=true`), which big repositories rely on, stays.
      ...(limit.monitor ? [] : ["-c", "core.fsmonitor=false"]),
      ...args,
    ]
    timing.saw?.(full)
    const child = spawn(program, full, {
      cwd,
      // Pathspecs are file names, not patterns.
      env: { ...gitEnv(), ...limit.env, GIT_LITERAL_PATHSPECS: "1" },
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [limit.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })
    if (limit.input !== undefined) {
      child.stdin?.on("error", () => {})
      child.stdin?.end(limit.input)
    }
    const chunks: Buffer[] = []
    let size = 0
    let capped = false
    let errors = Buffer.alloc(0)
    const timer = setTimeout(() => {
      if (limit.graceMs === undefined || process.platform === "win32" || child.pid === undefined) {
        killTree(child.pid)
        finish({ ok: false, kind: "timeout", status: 0, said: "" })
        return
      }
      timedOut = true
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {
        // Already gone.
      }
      hard = setTimeout(() => {
        killTree(child.pid)
        finish({ ok: false, kind: "timeout", status: 0, said: "" })
      }, limit.graceMs)
    }, limit.ms ?? timing.gitMs)
    if (scope?.aborted) ended()
    else scope?.addEventListener("abort", ended, { once: true })
    child.stdout?.on("data", (chunk: Buffer) => {
      if (capped) return
      if (size + chunk.length > limit.cap) {
        capped = true
        chunks.push(chunk.subarray(0, limit.cap - size))
        killTree(child.pid)
        return
      }
      size += chunk.length
      chunks.push(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errors.length < 4096) errors = Buffer.concat([errors, chunk])
    })
    child.on("error", (error: NodeJS.ErrnoException) => {
      // A folder gone since is not git gone.
      const folder = error.code !== "ENOENT" || statSync(cwd, { throwIfNoEntry: false })
      finish({
        ok: false,
        kind: folder ? (error.code === "ENOENT" ? "no-git" : "exit") : "exit",
        status: -1,
        said: folder ? oneLine(error.message, 200) : "the folder is gone",
      })
    })
    child.on("close", (code) => {
      if (timedOut) return finish({ ok: false, kind: "timeout", status: 0, said: "" })
      const out = Buffer.concat(chunks).toString("utf8")
      if (capped)
        return finish(
          limit.truncate
            ? { ok: true, out, cut: true }
            : { ok: false, kind: "big", status: 0, said: "" },
        )
      if (code === 0) return finish({ ok: true, out, cut: false })
      const said = oneLine(errors.toString("utf8").split("\n")[0] ?? "", 200)
      finish({ ok: false, kind: "exit", status: code ?? -1, said, out })
    })
  })

// A change read slower than this is polled less often; it is polled at most this seldom.
const maxChangesWait = 15_000

/**
 * How long to wait before reading a change again, given how long the last read `took`
 * and the usual `every`: after a slow read (a big repository) four times as long as it
 * took, up to 15 seconds, and the usual wait again as reads get fast.
 */
export const waitAfter = (took: number, every: number): number =>
  took > timing.slowMs ? Math.min(maxChangesWait, Math.max(every, took * 4)) : every
