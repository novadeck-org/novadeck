import { hashPaths } from "./paths.js"
import { hashUrls, type UrlRule } from "./urls.js"

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

// Account names that are ordinary words too, or too short to tell from part of one: written
// as they are, since replacing them would mangle the text around them.
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
  "guest",
  "home",
  "info",
  "linux",
  "local",
  "mac",
  "node",
  "owner",
  "public",
  "root",
  "runner",
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

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

// Names whose value is a secret, in a query (`?token=…`), a setting (`password=…`) or JSON.
const secretKey = String.raw`[\w.-]*?(?:token|secret|passw(?:or)?d|pwd|key|auth|credentials?|signature|sig)`

/** The shapes of secrets, each with what it becomes. */
const shapes: readonly (readonly [RegExp, string])[] = [
  // A URL's user and password: `https://ana:hunter2@host`.
  [/\b([a-z][\w+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1<redacted>@"],
  // Headers that carry credentials, as written in a request or its dump.
  [
    /\b((?:proxy-)?authorization|x-api-key|api-key|cookie|set-cookie)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+/gi,
    "$1$2<redacted>",
  ],
  [/\b(bearer)\s+[\w\-.~+/]+=*/gi, "$1 <redacted>"],
  // Private keys, whole.
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    "<secret>",
  ],
  // Keys and tokens by their prefixes: Anthropic and OpenAI, GitHub, AWS, Slack, npm,
  // GitLab, Google, Stripe, Hugging Face, and JSON web tokens.
  [/\bsk-(?:ant-|proj-)?[\w-]{16,}/g, "<secret>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<secret>"],
  [/\bgithub_pat_\w{20,}/g, "<secret>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<secret>"],
  [/\bxox[abposr]-[\w-]{10,}/g, "<secret>"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "<secret>"],
  [/\bglpat-[\w-]{20,}/g, "<secret>"],
  [/\bAIza[\w-]{35}/g, "<secret>"],
  [/\b[sr]k_(?:live|test)_\w{16,}/g, "<secret>"],
  [/\bhf_[A-Za-z]{30,}/g, "<secret>"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "<secret>"],
  [new RegExp(String.raw`("${secretKey}"\s*:\s*)"[^"]*"`, "gi"), '$1"<redacted>"'],
  [
    new RegExp(String.raw`((?:^|[?&;\s"'(,])${secretKey})=(?!<)[^&\s"';,)]+`, "gi"),
    "$1=<redacted>",
  ],
]

// Email addresses; not a Git remote's `git@host:`, which `hashUrls` wrote first.
const email = /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b(?!:[\w#~./<])/g

/**
 * A redactor for this machine: what it returns of any text is what a log may keep, and what
 * a person could send in a bug report. In order: the secrets this process holds, the values of
 * the secret variables, URL credentials, credential headers, tokens by their shapes,
 * `key=value` secrets; then addresses and Git remotes (see `hashUrls`); then email
 * addresses; then the paths (see `hashPaths`); then the account name, as a word of its own,
 * unless it is short or an ordinary word.
 */
export const createRedactor = (options: RedactOptions): Redactor => {
  const held = (options.secrets ?? [])
    .filter((secret): secret is string => secret !== undefined && secret.length >= 8)
    .toSorted((a, b) => b.length - a.length)
    .map((secret) => new RegExp(escape(secret), "g"))
  const named = (options.secretNames ?? []).map(
    (name) => new RegExp(String.raw`\b(${escape(name)})(\s*[=:]\s*)(["']?)(?!<)[^\s"']+`, "g"),
  )
  const user = options.user
  const account =
    user && user.length >= 3 && !commonNames.has(user.toLowerCase())
      ? new RegExp(String.raw`(?<![\w.-])${escape(user)}(?![\w-])`, "gi")
      : undefined
  return (text) => {
    let result = text
    for (const pattern of held) result = result.replace(pattern, "<secret>")
    for (const pattern of named) result = result.replace(pattern, "$1$2$3<redacted>")
    for (const [pattern, replacement] of shapes) result = result.replace(pattern, replacement)
    result = hashUrls(result, options).replace(email, "<email>")
    result = hashPaths(result, options)
    return account ? result.replace(account, "<user>") : result
  }
}
