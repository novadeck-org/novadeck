import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"

import { it as base } from "vitest"

import type { Git } from "./repo.js"
import type { FindProgram } from "./serving.js"

export { describe, expect } from "vitest"

/** A test's cleanups, run at its end, the last deferred first, every one tried. */
export type Resources = { readonly defer: (cleanup: Cleanup) => void }

type Cleanup = () => void | Promise<void>

// Runs every cleanup, the last deferred first, and fails with all that failed.
const dispose = async (cleanups: readonly Cleanup[]): Promise<void> => {
  const failed: unknown[] = []
  for (const cleanup of cleanups.toReversed()) {
    // eslint-disable-next-line no-await-in-loop -- Release dependents before what they stand on.
    await Promise.resolve()
      .then(cleanup)
      .catch((error: unknown) => failed.push(error))
  }
  if (failed.length > 0) throw new AggregateError(failed, "Test resource cleanup failed")
}

export const it = base.extend<{ resources: Resources }>({
  // eslint-disable-next-line no-empty-pattern -- Vitest reads destructuring to discover fixture dependencies.
  resources: async ({}, use) => {
    const cleanups: Cleanup[] = []
    try {
      await use({ defer: (cleanup) => cleanups.push(cleanup) })
    } finally {
      await dispose(cleanups)
    }
  },
})

/**
 * The program on the PATH of `env`, as the runner's `findProgram` finds it: the first file of
 * that name, trying `extensions` on Windows.
 */
export const findProgram: FindProgram = (name, { env, extensions }) => {
  const path = env.PATH ?? env.Path ?? ""
  const names = process.platform === "win32" ? extensions.map((each) => `${name}${each}`) : [name]
  for (const folder of path.split(delimiter).filter(Boolean))
    for (const each of names) {
      const found = join(folder, each)
      if (existsSync(found) && statSync(found).isFile()) return found
    }
  return undefined
}

// The variables that would send git elsewhere or change what it prints, which the runner's
// git leaves out of the person's environment (its `gitEnv`).
const redirecting =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|INDEX_VERSION|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CONFIG.*|EXTERNAL_DIFF|DIFF_OPTS|PAGER|EDITOR|SEQUENCE_EDITOR|.*_PATHSPECS|REPLACE_REF_BASE|NO_REPLACE_OBJECTS|SHALLOW_FILE|GRAFT_FILE|ATTR_SOURCE|TRACE.*)$/

/**
 * Git as the runner runs it for the tour: in `cwd`, found on the PATH the process has now, in
 * the process's environment without what would redirect it, no prompts or optional locks, in
 * English, its monitor off and pathspecs taken literally, its output kept up to `cap` within `ms`.
 */
export const git: Git = (cwd, args, { cap, ms }) =>
  new Promise((done) => {
    const program = findProgram("git", { env: process.env, extensions: [".exe"] })
    if (program === undefined) return done({ ok: false, kind: "no-git", said: "" })
    execFile(
      program,
      ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !redirecting.test(name.toUpperCase())),
          ),
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
          LC_ALL: "C",
          LANGUAGE: "C",
          GIT_LITERAL_PATHSPECS: "1",
        },
        maxBuffer: cap,
        timeout: ms,
        windowsHide: true,
      },
      (error, out, err) => {
        if (!error) return done({ ok: true, out })
        const said = err.trim().split("\n", 1)[0] ?? ""
        if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          return done({ ok: false, kind: "big", said })
        if (error.killed) return done({ ok: false, kind: "timeout", said })
        done({ ok: false, kind: "exit", said })
      },
    )
  })
