import { redactAs } from "@novadeck/secrets"

import { escapeRegExp } from "./escape.js"
import { pathHasher } from "./paths.js"
import { urlHasher, type UrlRule } from "./urls.js"

export type RedactOptions = UrlRule & {
  /**
   * Environment variables whose values are secrets: `NAME=value` and `NAME: value` lose the
   * value wherever they appear.
   */
  readonly secretNames?: readonly string[]
  /** Secrets this process holds, by value: each is replaced wherever it appears. */
  readonly secrets?: readonly (string | undefined)[]
}

/** Text as a log may keep it. */
export type Redactor = (text: string) => string

// Account names that are ordinary words too, or too short to tell from part of one, or the
// redactor's own placeholders: written as they are, since replacing them would mangle the text
// around them.
const commonNames = new Set([
  "admin",
  "administrator",
  "app",
  "build",
  "code",
  "data",
  "default",
  "demo",
  "dev",
  "docker",
  "email",
  "guest",
  "home",
  "info",
  "linux",
  "local",
  "mac",
  "node",
  "owner",
  "public",
  "redacted",
  "root",
  "runner",
  "secret",
  "server",
  "student",
  "system",
  "temp",
  "test",
  "ubuntu",
  "user",
  "users",
  "vagrant",
  "windows",
  "work",
])

// Names whose value is a secret, in a query (`?token=…`), a setting (`password=…`) or JSON.
const secretKey = String.raw`[\w.-]*?(?:token|secret|passw(?:or)?d|pass|pwd|key|auth|credentials?|signature|sig|session)`

/**
 * What a log hides beyond the shapes every terminal text loses (see `secrets` below): a URL's
 * user, whole credential headers, and the values of more names than a screen's, each with
 * what it becomes.
 */
const shapes: readonly (readonly [RegExp, string])[] = [
  // A key or certificate block, whole, before a rule below can take its BEGIN line for a value.
  [/-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g, "<secret>"],
  // A URL's user and password: `https://ana:hunter2@host`. The scheme is bounded and not
  // anchored to a word's start, so a long dotted run with no `://` is looked at once, not
  // again from each of its words.
  [/([a-z][\w+.-]{0,31}:\/\/)[^\s/@:]*(?::[^\s/@]*)?@/gi, "$1<redacted>@"],
  // Headers that carry credentials, as written in a request or its dump.
  [
    /\b((?:proxy-)?authorization|x-api-key|api-key|cookie|set-cookie)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+/gi,
    "$1$2<redacted>",
  ],
  [/\b(bearer)\s+[\w\-.~+/]+=*/gi, "$1 <redacted>"],
  [new RegExp(String.raw`("${secretKey}"\s*:\s*)"[^"]*"`, "gi"), '$1"<redacted>"'],
  [
    new RegExp(String.raw`((?:^|[?&;\s"'(,])${secretKey})(\s*=\s*)(?!<)[^&\s"';,)]+`, "gi"),
    "$1$2<redacted>",
  ],
  // `password: hunter2`, as YAML or a dump writes it, and `--password hunter2` on a command line.
  [
    /\b((?:passw(?:or)?d|pwd|secret|api[_-]?key|access[_-]?key|(?:auth|access|refresh|api)[_-]?token|token)\s*:\s*)(?!<)[^\s"',;]+/gi,
    "$1<redacted>",
  ],
  [
    /(--(?:passw(?:or)?d|secret|token|api-key|access-token|auth-token)[ =])(?!<)[^\s"']+/gi,
    "$1<redacted>",
  ],
  // What JSON.parse quotes of its input (`Unexpected token 'm', "my private"... is not valid
  // JSON`), wherever its message is written, as when another error's message wraps it. V8
  // quotes at most ten characters, so the quote is bounded.
  [
    /\b(Unexpected token) '[^\n]{1,4}?', "[^\n]{0,24}?"(?:\.\.\.)? is not valid JSON/g,
    "$1 (input withheld)",
  ],
]

/**
 * What a syntax error quotes of its input, wherever its message is written (a stack, an error
 * printed to stderr): everything from its first quote to the end of the line.
 */
const syntaxError = /(\bSyntaxError: [^"'`\n]*)["'`][^\n]*/g

/** `text` without the spaces, commas and colons at its end. */
export const trimSeparators = (text: string): string => {
  let end = text.length
  while (end > 0 && /[\s,:]/.test(text.charAt(end - 1))) end -= 1
  return text.slice(0, end)
}

// Keys and tokens by their shapes (see @novadeck/secrets), after the paths and addresses are
// hashed: a mask inside a path, an address or an email address would end it there for
// `pathHasher`, `urlHasher` and `email`, and leave the rest of it as it is, while a secret inside
// one is hashed with it. Before the account name, which would otherwise start a secret's value
// as `<user>` and so hide it from them.
const secrets = redactAs("<secret>")

// What an email address's local part and domain are made of, in any script.
const local = String.raw`\p{L}\p{M}\p{N}_.%+\-`
const label = String.raw`[\p{L}\p{M}\p{N}\-]`

// Email addresses: with a domain (`zoë@exämple.de`), or a host alone (`ana@intranet`). Not a
// Git remote's `git@host:`, which `urlHasher` wrote first, a package's version or tag
// (`react@19.3.1`, `vite@latest`, `log@workspace:*`), or a stack frame's `fn@https://…`. The
// local part starts where a run of its characters starts, so a long run without an `@` is
// read once, not again from each of its characters.
const email = new RegExp(
  String.raw`(?<![${local}])[${local}]+@(?:` +
    String.raw`${label}+(?:\.${label}+)*\.\p{L}[\p{L}\p{M}]+(?![\p{L}\p{M}\p{N}_])(?!:[\w#~./<])` +
    String.raw`|(?!(?:latest|next|beta|alpha|canary|rc|lts|stable|nightly|experimental|insiders|main|master|head|v\d)(?![\p{L}\p{M}\p{N}_\-]))` +
    String.raw`\p{L}${label}*(?![\p{L}\p{M}\p{N}_\-:+/]|\.${label})` +
    ")",
  "giu",
)

/**
 * A redactor for this machine: what it returns of any text is what a log may keep, and what
 * a person could send in a bug report. In order: the secrets this process holds, the values of
 * the secret variables, URL credentials, credential headers, `key=value` secrets; then
 * addresses and Git remotes (see `urlHasher`); then email addresses; then the paths (see
 * `pathHasher`); then keys and tokens by their shapes; then the account name, as a word of its
 * own, unless it is short or an ordinary word.
 */
export const createRedactor = (options: RedactOptions): Redactor => {
  const held = (options.secrets ?? [])
    .filter((secret): secret is string => secret !== undefined && secret.length >= 8)
    .toSorted((a, b) => b.length - a.length)
    .map((secret) => new RegExp(escapeRegExp(secret), "g"))
  const named = (options.secretNames ?? []).map(
    (name) =>
      new RegExp(String.raw`\b(${escapeRegExp(name)})(\s*[=:]\s*)(["']?)(?!<)[^\s"']+`, "g"),
  )
  const user = options.user
  const account =
    user && user.length >= 3 && !commonNames.has(user.toLowerCase())
      ? new RegExp(String.raw`(?<![\w.-])${escapeRegExp(user)}(?![\w-])`, "gi")
      : undefined
  const urls = urlHasher(options)
  const paths = pathHasher(options)
  return (text) => {
    let result = text
    for (const pattern of held) result = result.replace(pattern, "<secret>")
    for (const pattern of named) result = result.replace(pattern, "$1$2$3<redacted>")
    for (const [pattern, replacement] of shapes) result = result.replace(pattern, replacement)
    result = result.replace(
      syntaxError,
      (_match, head: string) => `${trimSeparators(head)} (input withheld)`,
    )
    result = urls(result).replace(email, "<email>")
    result = secrets(paths(result))
    return account ? result.replace(account, "<user>") : result
  }
}
