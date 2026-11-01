// Granted commands: which may be granted at all, and whether a call is one.
import type { GrantCommand } from "../grants.js"
import { programName, runsOtherCode } from "./runners.js"

const bare = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

// `gh pr|issue <these>` and `gh repo view` only read, and run with no dialog: a grant for them
// would only be asked for in vain.
const readOnly = new Set(["view", "checks", "list", "diff", "status"])

const readsOnly = ([program, noun, verb]: readonly string[]): boolean =>
  program === "gh" &&
  verb !== undefined &&
  ((noun === "repo" && verb === "view") ||
    ((noun === "pr" || noun === "issue") && readOnly.has(verb)))

/** Why `command` can't be granted, or undefined when it can. */
export const refusesCommand = (command: GrantCommand): string | undefined => {
  const [program] = command.argv
  if (program === undefined) return "no words"
  // A prefix can't be granted safely: too many programs run what follows them. Only exact
  // commands are, and a stored `rest` command from an earlier build matches nothing.
  if (command.rest)
    return "'rest' (followed by anything) is not granted: list each command as exact words"
  if (!bare.test(program)) return "the program must be a bare name"
  // `GIT` or `git.exe` runs git where names are case-free or take an extension, past every
  // check below that names a program: only its plain name is granted.
  if (programName(program) !== program)
    return "write the program as its plain name: lower case, without .exe, .cmd or .bat"
  for (const [index, word] of command.argv.entries()) {
    const body = ["--body", "-b"].includes(command.argv[index - 1] ?? "")
    for (const ch of word) {
      const code = ch.charCodeAt(0)
      if ((code >= 0x20 && code <= 0x7e) || (ch === "\n" && body)) continue
      return "words must be printable ASCII"
    }
  }
  if (runsOtherCode(program)) return `${program} runs other code`
  if (readsOnly(command.argv)) return "read-only: it needs no grant"
  return undefined
}

/** Whether the lexed `argv` is exactly `command`'s words. */
export const matchesCommand = (command: GrantCommand, argv: readonly string[]): boolean => {
  if (refusesCommand(command) !== undefined) return false
  const own = command.argv
  return argv.length === own.length && own.every((word, i) => word === argv[i])
}
