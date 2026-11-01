// Matching a call against grants: lex it, hold it to the project folder, try presets then commands.
import { posix } from "node:path"

import type { FsLookups, GitLookups, GrantMatch, GrantScope, ShellCall } from "../grants.js"
import { flavourOf } from "../paths.js"
import { matchesCommand } from "./commands.js"
import { inside } from "./inside.js"
import { lexCall } from "./lexer.js"
import { matchesPr } from "./pr.js"
import { matchesPush } from "./push.js"

/**
 * Whether a folder the command may run in holds a file named `program`, with any extension or
 * none: cmd looks in the current folder before PATH and runs `git.exe`, `git.js`, `git.vbs`
 * or a `git` of any other PATHEXT kind there in place of the program on PATH. Also true where
 * a folder can't be read or no program is named.
 */
const runsFromFolders = async (
  program: string | undefined,
  folders: readonly string[],
  fs: FsLookups,
): Promise<boolean> => {
  if (program === undefined) return true
  const name = (program.split(/[\\/]/).pop() as string).toLowerCase()
  const listed = await Promise.all(folders.map((folder) => fs.names(folder)))
  return listed.some(
    (names) =>
      names === undefined ||
      names.some((each) => {
        const lower = each.toLowerCase()
        return lower === name || lower.startsWith(`${name}.`)
      }),
  )
}

/** The first scope entry that lets `call` through, or null when none does. */
export const matchCall = async (
  call: ShellCall,
  scopes: readonly GrantScope[],
  git: GitLookups,
  projectRoot: string,
  fs: FsLookups,
  terminalFolder?: string,
): Promise<{ scope: number; match: GrantMatch } | null> => {
  const lexed = lexCall(call)
  if (!lexed.ok) return null
  if (call.cwd !== null && !inside(call.cwd, projectRoot)) return null
  const { argv } = lexed
  // Codex's hooks name neither the call's `workdir` nor its mode: its rollout does. A call whose
  // rollout can't be read, or whose turn plans or is not known not to, is no match.
  let callFolder = call.cwd
  if (call.folderHidden === true) {
    if (call.rollout === undefined) return null
    const rollout = call.rollout
    const said = await Promise.resolve()
      .then(() => fs.codexCall(rollout, call.command))
      .catch(() => undefined)
    if (said === undefined || said.planning !== false) return null
    if (said.workdir !== undefined && call.sessionFolder !== undefined) {
      callFolder =
        said.workdir === null
          ? call.sessionFolder
          : flavourOf(call.sessionFolder, said.workdir).resolve(call.sessionFolder, said.workdir)
      if (!inside(callFolder, projectRoot)) return null
    }
  }
  // Where the command may run: the project folder, the session's, the call's, the terminal's.
  const folders = [
    ...new Set(
      [projectRoot, call.sessionFolder, callFolder, terminalFolder].filter(
        (f) => f !== undefined && f !== null,
      ),
    ),
  ] as string[]
  if (call.dialect === "windows-quote-free" && (await runsFromFolders(argv[0], folders, fs)))
    return null
  // Claude Code's Bash tool on Windows (a POSIX dialect over a Windows project) is Git Bash.
  const gitBash = call.dialect === undefined && flavourOf(projectRoot) !== posix
  // The folder git is asked in: the call's own, else the terminal's, unless the command may
  // run in a folder nothing shows (Codex's `workdir`, where its rollout doesn't say).
  const refs = callFolder ?? (call.folderHidden === true ? null : (terminalFolder ?? null))
  for (const [scope, grant] of scopes.entries()) {
    for (const preset of grant.presets) {
      const ok =
        preset === "push"
          ? // eslint-disable-next-line no-await-in-loop -- The first entry that matches decides.
            await matchesPush(argv, grant.repos, git, refs)
          : // eslint-disable-next-line no-await-in-loop -- As above.
            await matchesPr(argv, grant.repos, { cwd: call.cwd, root: projectRoot, gitBash }, fs)
      if (ok) return { scope, match: { kind: "preset", preset } }
    }
    for (const [index, command] of grant.commands.entries())
      if (matchesCommand(command, argv)) return { scope, match: { kind: "command", index } }
  }
  return null
}
