import { findProgram } from "./programs.js"

// The git found for each PATH the runner had, so a test or a changed PATH looks again.
const found = new Map<string, string | undefined>()

/**
 * Git, found on the PATH by an absolute entry, so a program of that name in the folder the
 * runner or its child works in (as Windows searches its working folder first) never runs;
 * undefined without one. Only `git.exe` on Windows: a `.cmd` doesn't run without a shell.
 */
export const gitPath = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const key = env.PATH ?? env.Path ?? ""
  if (!found.has(key)) found.set(key, findProgram("git", { env, extensions: [".exe"] }))
  return found.get(key)
}

// The variables of the person's environment that point git at another repository, another
// configuration or another way to diff, or make it write traces: the runner may have them
// from wherever it was started, and what it shows is the person's repository as their own
// git would show it. The rest (GIT_CEILING_DIRECTORIES, GIT_EXEC_PATH…) stay.
const redirecting =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|INDEX_VERSION|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CONFIG.*|EXTERNAL_DIFF|DIFF_OPTS|PAGER|EDITOR|SEQUENCE_EDITOR|.*_PATHSPECS|REPLACE_REF_BASE|NO_REPLACE_OBJECTS|SHALLOW_FILE|GRAFT_FILE|ATTR_SOURCE|TRACE.*)$/

/**
 * The environment the runner's git runs in, for every look it takes: the person's own, but
 * for those, with optional locks off so looking never takes the index lock the agent's own
 * git needs, no prompts, and no fetching of missing objects over the network.
 */
export const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !redirecting.test(name.toUpperCase())),
  ),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  // Git's messages are read for "not a git repository", so they are English whatever the
  // system's locale; names travel as bytes (-z, quotepath off), which the locale never touches.
  LC_ALL: "C",
  LANGUAGE: "C",
})
