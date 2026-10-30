// Terminals show secrets. These fixed rules mark what looks like one by its shape alone:
// nothing is learned or configured, so the same text is masked the same on every machine.
import { hide, hideValue } from "./marks.js"
import { soundsSecret } from "./names.js"
import { closesLiteral, keyLikeRun, worthHiding } from "./values.js"

// What a match becomes: handed the match and its groups, as `String.replace` hands them.
type Replacer = (...match: string[]) => string
// Where a match was found, for a rule that reads what is before it.
type Where = { readonly offset: number; readonly text: string }
type Judge = (where: Where, ...match: string[]) => string

export type Rule =
  // Every match replaced at once.
  | { readonly pattern: RegExp; readonly replace: Replacer }
  // Matches judged one at a time, and read inside again where one is kept (see `scan`). A
  // `field`'s value is read only after a match whose `name` group sounds secret; ordinary
  // fields can contain nested secrets, but need no repeated parsing of their overlapping values.
  | {
      readonly pattern: RegExp
      readonly judge: Judge
      readonly field?: { readonly name: number; readonly value: RegExp }
    }

// The longest value a rule takes whole at once; a secret that reaches it is masked to the end of its run.
export const valueCap = 1024

// A run of `characters` at least `min` long.
const atLeast = (characters: string, min: number): string => `[${characters}]{${min},}`
// What base64url is made of.
const urlSafe = "A-Za-z0-9_\\-"
// A token with a prefix of its own (`prefix`, a pattern), once its run is long enough to be one.
const token = (prefix: string, characters: string, min: number): Rule => ({
  pattern: new RegExp(`(?<![\\w])${prefix}${atLeast(characters, min)}`, "g"),
  replace: hide,
})
// The head kept, and the value after it hidden.
const keepHead: Replacer = (_all, head, value) => `${head}${hide(value)}`

// The text base64url `text` decodes to; empty when it is no base64.
const decoded = (text: string): string => {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/")
  try {
    return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
  } catch {
    return ""
  }
}

// A quoted value; one opened and never closed runs to the end of the line. A string inside
// JSON that is itself in a string has its quotes escaped.
const quoted = `\\\\"(?:[^\\\\\\n]|\\\\(?!"))*\\\\"|"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|"[^\\n]*|'[^\\n]*`

export const rules: readonly Rule[] = [
  // A key block, or the start of one whose end scrolled away.
  { pattern: /-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(-----END [A-Z0-9 ]*-----|$)/g, replace: hide },
  // Tokens with a prefix of their own.
  token("sk-", urlSafe, 6),
  token("[sr]k_(?:live|test)_", "A-Za-z0-9", 8),
  token("gh[pousr]_", "A-Za-z0-9", 4),
  token("github_pat_", "A-Za-z0-9_", 10),
  token("glpat-", urlSafe, 10),
  token("hf_", "A-Za-z0-9", 16),
  token("hvs\\.", `${urlSafe}.`, 20),
  token("npm_", "A-Za-z0-9", 20),
  token("pypi-", "A-Za-z0-9_=-", 20),
  token("ya29\\.(?=[A-Za-z0-9_.-]*[A-Z0-9])", `${urlSafe}.`, 20),
  token("AIza", urlSafe, 30),
  {
    pattern: new RegExp(`(?<![\\w])SG\\.${atLeast(urlSafe, 16)}\\.${atLeast(urlSafe, 16)}`, "g"),
    replace: hide,
  },
  // A Discord bot token: three parts, the first the user id's digits in base64.
  {
    pattern: /(?<![\w.-])([A-Za-z0-9_-]{18,32})\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}/g,
    replace: (all, id) => (/^\d{17,20}$/.test(decoded(id)) ? hide(all) : all),
  },
  { pattern: new RegExp(`AGE-SECRET-KEY-1${atLeast("A-Z0-9", 20)}`, "g"), replace: hide },
  // Skipped only when more capitals end the word (a placeholder). A secret glued on, which may
  // start with a capital or a digit, is masked with the id, since what is left of it after the
  // id may not look like a secret on its own.
  {
    pattern: /(?<![\w])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z]+(?![0-9A-Za-z+/]))[0-9A-Za-z+/]*=*/g,
    replace: hide,
  },
  token("xox[abeoprs]-", "A-Za-z0-9-", 10),
  { pattern: /(?<![\w])eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, replace: hide },
  // Webhooks carry their secret in the path.
  {
    pattern: /(hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/webhooks\/)([^\s"'<>]+)/gi,
    replace: keepHead,
  },
  // user:password@host in any URL, even with no user.
  {
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/@:]*:[^\s/]*)@/gi,
    replace: (_all, scheme, info) => `${scheme}${hide(info)}@`,
  },
  // A key as the whole userinfo, as Sentry's DSN has it.
  {
    pattern:
      /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([A-Za-z0-9]{16,}|[A-Za-z0-9]{12,}(?=@[^\s/]*(?:sentry|ingest)))@/gi,
    replace: (_all, scheme, key) => `${scheme}${hide(key)}@`,
  },
  // A secret in a URL's query.
  {
    pattern: /([?&])([\w.-]+)=([^&\s#]+)/g,
    replace: (all, joint, name, value) =>
      soundsSecret(name) && worthHiding(value) ? `${joint}${name}=${hide(value)}` : all,
  },
  // Whole headers: the credential is everything after the name.
  {
    pattern: /\b(Authorization\s*[:=]\s*(?:(?:Bearer|Basic|Token|Digest)\s+)?)(?!\uE000)(\S+)/gi,
    replace: keepHead,
  },
  { pattern: /\b((?:Set-)?Cookie\s*:[ \t]*)([^\n]+)/gi, replace: keepHead },
  {
    pattern: /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{4,})/gi,
    replace: (all, scheme, gap, value) =>
      /\d/.test(value) || value.length >= 16 ? `${scheme}${gap}${hide(value)}` : all,
  },
  // aws configure asks for the key by name.
  { pattern: /(\bSecret Access Key[^:\n]{0,64}:[ \t]*)(\S+)/gi, replace: keepHead },
  // AUTH=Basic dXNlcjpwYXNz, where the scheme says it is a credential.
  { pattern: /([=:][ \t]*(?:Basic|Bearer)[ \t]+)([A-Za-z0-9+/=._~-]{8,})/g, replace: keepHead },
  // Command lines that take a password in their own way.
  { pattern: /(\bredis-cli\b[^\n]{0,256}?\s-a\s+)(?!-)(\S+)/g, replace: keepHead },
  { pattern: /(\bhtpasswd\b[^\n]{0,256}?\s-\w*b\w*\s+\S+\s+\S+\s+)(\S+)/g, replace: keepHead },
  { pattern: /(\bopenssl\b[^\n]{0,256}?\s-k\s+)(?!-)(\S+)/g, replace: keepHead },
  { pattern: /(\bopenssl\b[^\n]{0,256}?\s-pass(?:in|out)?\s+pass:)(\S+)/g, replace: keepHead },
  {
    pattern: /(\b(?:mysql|mysqladmin|mysqldump)\w*\b[^\n]{0,256}?\s-p)(?=\S)(\S+)/g,
    replace: keepHead,
  },
  { pattern: /(\b(?:docker\s+login|sshpass)\b[^\n]{0,256}?\s-p\s+)(?!-)(\S+)/g, replace: keepHead },
  { pattern: /(\bcurl\b[^\n]{0,256}?\s(?:-u|--user)[ =]\s*)(?!-)(\S+)/g, replace: keepHead },
  // --password hunter2, by the flag's exact name.
  {
    pattern: new RegExp(
      `(--(?:password|passwd|pass|pwd|token|auth-token|access-token|api-key|apikey|secret|client-secret|auth|bearer|credentials?|passphrase)(?:=|[ \\t]+))(?!-)(${quoted}|\\S+)`,
      "gi",
    ),
    judge: ({ offset, text }, all, head, value) =>
      worthHiding(value) && !closesLiteral(value, offset, text)
        ? `${head}${hideValue(value)}`
        : all,
  },
  // NAME=value, where the name sounds secret.
  {
    pattern: new RegExp(
      `(?<![\\p{L}\\p{N}_.-])([\\p{L}_][\\p{L}\\p{N}_.-]*)([ \\t]*=[ \\t]*)`,
      "gu",
    ),
    judge: ({ offset, text }, all, name, joint, value) =>
      worthHiding(value, true) && !closesLiteral(value, offset, text)
        ? `${name}${joint}${hideValue(value)}`
        : all,
    field: { name: 1, value: new RegExp(`${quoted}|[^\\s"',;&]{1,${valueCap}}`, "uy") },
  },
  // Polish: hasło: tajne, haslo=tajne
  {
    pattern: new RegExp(
      `(?<![\\p{L}])(has[lł]o|has[lł]a)([ \\t]*[:=][ \\t]*)(${quoted}|\\S+)`,
      "giu",
    ),
    judge: ({ offset, text }, all, name, joint, value) =>
      worthHiding(value) && !closesLiteral(value, offset, text)
        ? `${name}${joint}${hideValue(value)}`
        : all,
  },
  // fish: set -x NAME value
  {
    pattern: /(\bset[ \t]+(?:-\w+[ \t]+)*)([A-Za-z_]\w*)([ \t]+)(?!-)(\S+)/g,
    judge: (_where, all, head, name, gap, value) =>
      soundsSecret(name) && worthHiding(value) ? `${head}${name}${gap}${hide(value)}` : all,
  },
  // "name": "value", as JSON has it, and 'name': 'value'; in a string of a log line the
  // quotes are escaped: {\"name\":\"value\"}.
  {
    pattern: new RegExp(`(\\\\?)(["'])([\\p{L}_][\\p{L}\\p{N}_.-]*)\\1\\2([ \\t]*:[ \\t]*)`, "gu"),
    judge: ({ offset, text }, all, slash, quote, name, joint, value) =>
      worthHiding(value) && !closesLiteral(value, offset, text)
        ? `${slash}${quote}${name}${slash}${quote}${joint}${hideValue(value)}`
        : all,
    field: { name: 3, value: new RegExp(`${quoted}|[^\\s,}\\]]+`, "uy") },
  },
  // name: value, as YAML and headers have it.
  {
    pattern: new RegExp(
      `(?<![\\p{L}\\p{N}_.-])([\\p{L}_][\\p{L}\\p{N}_.-]*)([ \\t]*:[ \\t]+)`,
      "gu",
    ),
    judge: ({ offset, text }, all, name, joint, value) =>
      worthHiding(value, true) && !closesLiteral(value, offset, text)
        ? `${name}${joint}${hideValue(value)}`
        : all,
    field: { name: 1, value: new RegExp(`${quoted}|[^\\s"',;]{1,${valueCap}}`, "uy") },
  },
  // A hash of a secret is as good as the secret; a commit id or a file's checksum is not one.
  {
    pattern:
      /(?<![0-9a-zA-Z_])(?<!sha(?:1|256|512)[:-])(?<!commit )(?<!diff-)[0-9a-f]{32,}(?![0-9a-zA-Z_])(?!\s{2}\S)/gi,
    replace: (run) => (run.length === 40 || run.length === 44 ? run : hide(run)),
  },
  // Base64 long enough to hold a key. Paths, words and identifiers are long and mixed too:
  // a run needs digits and no long word in it, and is never part of a path.
  {
    pattern:
      /(?<![\w/\\.+=-])(?<!;base64,)(?!sha(?:1|256|384|512)-)[A-Za-z0-9+/_-]{40,}={0,2}(?![\w\\+-]|\.[\w\\.+-])/g,
    replace: (run) => (keyLikeRun(run) ? hide(run) : run),
  },
]
