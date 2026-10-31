// Granted commands: which may be granted at all, and whether a call is one.
import type { GrantCommand } from "../grants.js"
import { programName } from "./lexer.js"

const wrappers = new Set(["env", "sudo", "command", "exec", "xargs", "cd"])
const interpreters = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
  "node",
  "bun",
  "deno",
  "perl",
  "ruby",
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "make",
  "cargo",
  "uv",
  "docker",
  "podman",
  "nohup",
  "nice",
  "time",
  "timeout",
  "eval",
  "source",
  "busybox",
])
const python = /^python[0-9.]*$/
const bare = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const plain = /^[A-Za-z0-9._/:@%+,-][A-Za-z0-9._/:=@%+,-]*$/

/** Programs that run other code: never granted, exact or with `rest`. */
export const runsOtherCode = (word: string): boolean => {
  const program = programName(word)
  return wrappers.has(program) || interpreters.has(program) || python.test(program)
}

/** Why `command` can't be granted, or undefined when it can. */
export const refusesCommand = (command: GrantCommand): string | undefined => {
  const [program, second] = command.argv
  if (program === undefined) return "no words"
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
  if (!command.rest) return undefined
  if (program === "git" || program === "gh") return `${program} is covered by the presets`
  if (command.argv.length < 2 || second === undefined) return "followed-by-anything needs two words"
  if (second.startsWith("-")) return "the second word must not be an option"
  return undefined
}

/** Whether the lexed `argv` is `command`'s words, or, with `rest`, those and plain words. */
export const matchesCommand = (command: GrantCommand, argv: readonly string[]): boolean => {
  if (refusesCommand(command) !== undefined) return false
  const own = command.argv
  if (!command.rest) return argv.length === own.length && own.every((word, i) => word === argv[i])
  return (
    argv.length > own.length &&
    own.every((word, i) => word === argv[i]) &&
    argv.slice(own.length).every((word) => plain.test(word))
  )
}
