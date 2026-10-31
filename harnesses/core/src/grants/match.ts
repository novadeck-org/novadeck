// Matching a call against grants: lex it, hold it to the project folder, try presets then commands.
import type { FsLookups, GitLookups, GrantMatch, GrantScope, ShellCall } from "../grants.js"
import { flavourOf } from "../paths.js"
import { matchesCommand } from "./commands.js"
import { inside } from "./inside.js"
import { lexCall } from "./lexer.js"
import { matchesPr } from "./pr.js"
import { matchesPush } from "./push.js"

// cmd looks in the current folder before PATH, and runs these as programs.
const executable = [".exe", ".com", ".bat", ".cmd", ".ps1"]

/**
 * Whether the project root holds `program` with an executable suffix, which cmd would run
 * from the folder in place of the program on PATH; also true where that can't be told.
 */
const runsFromProject = async (
  program: string | undefined,
  root: string,
  fs: FsLookups,
): Promise<boolean> => {
  if (program === undefined) return true
  const rules = flavourOf(root)
  const found = await Promise.all(
    executable.map((suffix) => fs.exists(rules.join(root, `${program}${suffix}`))),
  )
  return found.some((exists) => exists !== false)
}

/** The first scope entry that lets `call` through, or null when none does. */
export const matchCall = async (
  call: ShellCall,
  scopes: readonly GrantScope[],
  git: GitLookups,
  projectRoot: string,
  fs: FsLookups,
): Promise<{ scope: number; match: GrantMatch } | null> => {
  const lexed = lexCall(call)
  if (!lexed.ok) return null
  if (call.cwd !== null && !inside(call.cwd, projectRoot)) return null
  const { argv } = lexed
  if (call.dialect === "windows-quote-free" && (await runsFromProject(argv[0], projectRoot, fs)))
    return null
  for (const [scope, grant] of scopes.entries()) {
    for (const preset of grant.presets) {
      const ok =
        preset === "push"
          ? // eslint-disable-next-line no-await-in-loop -- The first entry that matches decides.
            await matchesPush(argv, grant.repos, git, call.cwd)
          : // eslint-disable-next-line no-await-in-loop -- As above.
            await matchesPr(argv, grant.repos, { cwd: call.cwd, root: projectRoot }, fs)
      if (ok) return { scope, match: { kind: "preset", preset } }
    }
    for (const [index, command] of grant.commands.entries())
      if (matchesCommand(command, argv)) return { scope, match: { kind: "command", index } }
  }
  return null
}
