// Matching a call against grants: lex it, hold it to the project folder, try presets then commands.
import type { GitLookups, GrantMatch, GrantScope, ShellCall } from "../grants.js"
import { matchesCommand } from "./commands.js"
import { inside } from "./inside.js"
import { lexCall } from "./lexer.js"
import { matchesPr } from "./pr.js"
import { matchesPush } from "./push.js"

/** The first scope entry that lets `call` through, or null when none does. */
export const matchCall = async (
  call: ShellCall,
  scopes: readonly GrantScope[],
  git: GitLookups,
  projectRoot: string,
): Promise<{ scope: number; match: GrantMatch } | null> => {
  const lexed = lexCall(call)
  if (!lexed.ok) return null
  if (call.cwd !== null && !inside(call.cwd, projectRoot)) return null
  const { argv } = lexed
  for (const [scope, grant] of scopes.entries()) {
    for (const preset of grant.presets) {
      const ok =
        preset === "push"
          ? // eslint-disable-next-line no-await-in-loop -- The first entry that matches decides.
            await matchesPush(argv, grant.repos, git, call.cwd)
          : matchesPr(argv, grant.repos, { cwd: call.cwd, root: projectRoot })
      if (ok) return { scope, match: { kind: "preset", preset } }
    }
    for (const [index, command] of grant.commands.entries())
      if (matchesCommand(command, argv)) return { scope, match: { kind: "command", index } }
  }
  return null
}
