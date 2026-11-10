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
 * Programs whose next word is a subcommand or a script of the project's own (`pnpm dev`,
 * `cargo test`, `docker compose`): only theirs show. Any other program's words may be
 * anything, a password included (`openssl passwd …`), so none of them shows.
 */
const subcommanded = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "npx",
  "bunx",
  "cargo",
  "go",
  "make",
  "just",
  "turbo",
  "nx",
  "vite",
  "vitest",
  "jest",
  "next",
  "astro",
  "docker",
  "podman",
  "kubectl",
  "git",
  "gh",
  "uv",
  "poetry",
  "pip",
  "pip3",
  "mix",
  "rails",
  "rake",
  "bundle",
  "dotnet",
  "gradle",
  "gradlew",
  "mvn",
  "terraform",
  "pytest",
  "tsc",
  "wrangler",
])

/** Subcommands that run a script named next (`pnpm run dev`): that name shows too. */
const runners = new Set(["run", "exec", "x", "dlx", "compose"])

/**
 * A word that names a subcommand or a script and can carry no value: letters first, then
 * lowercase letters, digits and `:._-` (`dev:web`, `run`, `test`), short, with no more than
 * one digit. An assignment, an option, a path, an address, a quote or a token never is.
 */
const plainWord = (word: string): boolean =>
  /^[a-z][a-z0-9:._-]{0,23}$/.test(word) && (word.match(/\d/g)?.length ?? 0) <= 1

/**
 * A shell's foreground command as agents may read it in a listing: its program, and for a
 * program known to take a subcommand (see `subcommanded`) that subcommand, and the script a
 * runner subcommand runs, each only where it is a plain word (see `plainWord`). So no
 * argument that could carry a secret shows: `curl -H "Authorization: …"`, `login ghp_…`,
 * `openssl passwd hunter2`. A script's interpreter gives way to the script, with none of its
 * arguments (`node …/pnpm.cjs dev:web` reads `pnpm dev:web`, `python3 deploy.py …` reads
 * `deploy`). Null when nothing tells.
 */
export const shownCommand = (argv: readonly string[] | null | undefined): string | null => {
  if (!argv || argv.length === 0) return null
  const [first, ...rest] = argv
  const program = nameOf(first!)
  const script = interpreters.has(program.toLowerCase()) && rest[0] && !rest[0].startsWith("-")
  const named = script ? nameOf(rest[0]!) : program
  if (!named || !/^[\w.-]{1,40}$/.test(named)) return null
  const args = script ? rest.slice(1) : rest
  if (!subcommanded.has(named.toLowerCase())) return named
  const words: string[] = []
  for (const word of args) {
    if (!plainWord(word)) break
    words.push(word)
    if (words.length === 2 || !runners.has(word)) break
  }
  return [named, ...words].join(" ")
}
