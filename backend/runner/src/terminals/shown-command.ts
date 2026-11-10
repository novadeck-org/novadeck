import { basename } from "node:path"

/** Programs that run a script named next: the script, not the interpreter, says what runs. */
const interpreters = new Set([
  "node",
  "nodejs",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "perl",
  "sh",
  "bash",
  "zsh",
  "pwsh",
  "powershell",
])

/** A program's name as people say it: its file's name without a folder or extension. */
const nameOf = (path: string): string =>
  basename(path.replaceAll("\\", "/")).replace(/\.(?:exe|cmd|bat|ps1|[cm]?js|py|rb|pl|sh)$/i, "")

/**
 * A word that names what runs and can carry no value: letters first, then letters, digits
 * and `:._-` (`dev:web`, `run`, `test`), short, with few digits. An assignment, an option, a
 * path, an address, a quote or a long token never is.
 */
const plainWord = (word: string): boolean =>
  /^[A-Za-z][\w:.-]{0,23}$/.test(word) && (word.match(/\d/g)?.length ?? 0) <= 2

/** How many words after the program show at most. */
const maxWords = 3

/**
 * A shell's foreground command as agents may read it in a listing: its program, and the
 * plain words after it up to the first that could carry a value (see `plainWord`), so a
 * secret in an argument (`curl -H "Authorization: …"`, `login ghp_…`) never shows. A script's
 * interpreter gives way to the script (`node …/pnpm.cjs dev:web` reads `pnpm dev:web`).
 * Null when nothing tells.
 */
export const shownCommand = (argv: readonly string[] | null | undefined): string | null => {
  if (!argv || argv.length === 0) return null
  const [first, ...rest] = argv
  const program = nameOf(first!)
  const script = interpreters.has(program.toLowerCase()) && rest[0] && !rest[0].startsWith("-")
  const named = script ? nameOf(rest[0]!) : program
  if (!named || !/^[\w.-]{1,40}$/.test(named)) return null
  const words: string[] = []
  for (const word of script ? rest.slice(1) : rest) {
    if (words.length === maxWords || !plainWord(word)) break
    words.push(word)
  }
  return [named, ...words].join(" ")
}
