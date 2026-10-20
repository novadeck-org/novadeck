// Terminals show secrets. These fixed rules strip what looks like one by its shape alone:
// nothing is learned or configured, so the same text is masked the same on every machine.
//
// A secret is first marked in place: each of its characters becomes a sentinel, so the text
// keeps its length and everything around the secret. Marking a screen's continued rows as one
// text and as separate rows then lines up character for character, and the union of the two
// is what is masked. Marks are rendered as `[redacted]`, or the caller's placeholder, only at
// the end.

/** What a secret becomes, unless the caller names its own placeholder. */
export const redacted = "[redacted]"

// A run of `characters` at least `min` long.
const wrapped = (characters: string, min: number): string => `[${characters}]{${min},}`
// A literal, ready for a pattern.
const spaced = (literal: string): string =>
  [...literal].map((character) => character.replace(/[.\\-]/g, "\\$&")).join("")
const url = "A-Za-z0-9_\\-"
// The text base64url `text` decodes to; empty when it is no base64.
const decoded = (text: string): string => {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/")
  try {
    return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
  } catch {
    return ""
  }
}

// Stands for a secret's character. A private-use character is no letter, digit or space, so
// patterns treat it as the boundary it is.
const sentinel = "\uE000"
// The same length, with a sentinel for each character but the newlines.
const hide = (text: string): string => text.replaceAll(/[^\n]/g, sentinel)
// A quoted value with its quotes (and a JSON string's escaped quotes) kept, and what is inside hidden.
const hideValue = (value: string): string => {
  let open = 0
  let close = 0
  if (value.startsWith('\\"')) {
    open = 2
    if (value.length >= 4 && value.endsWith('\\"')) close = 2
  } else if (value[0] === '"' || value[0] === "'") {
    open = 1
    if (value.length >= 2 && value.endsWith(value[0] ?? "")) close = 1
  }
  return (
    value.slice(0, open) +
    hide(value.slice(open, value.length - close)) +
    value.slice(value.length - close)
  )
}
const mask = hide

type Replacer = (...match: string[]) => string
// `true` scans inside an unchanged match. A value pattern instead reads a field's value
// only when its name (the numbered group) sounds secret; ordinary fields can contain
// nested secrets, but need no repeated parsing of their overlapping values.
type Rule = readonly [RegExp, Replacer, (true | RegExp)?, number?]

// Words that make a name a secret's wherever it is, and ones that do so only whole.
const secretInside = /(secret|passw|passphrase|apikey|privatekey|credential|has[lł][oa])/
const secretWords = new Set(["token", "pass", "pwd", "cookie", "bearer", "signature", "sig"])
// Words before `key`, which says what it opens: `api key`, but not `primary key` or `sort key`.
const keyOf = new Set([
  "api",
  "secret",
  "private",
  "access",
  "auth",
  "encryption",
  "signing",
  "license",
  "ssh",
  "account",
  "master",
  "client",
  "session",
])
// Words that end a name which only counts or points at a secret.
const notSecret = new Set([
  "count",
  "size",
  "budget",
  "limit",
  "length",
  "max",
  "min",
  "type",
  "name",
  "file",
  "path",
  "dir",
  "id",
  "ttl",
  "expiry",
  "expires",
  "url",
  "uri",
  "header",
  "field",
  "prefix",
])
// Values that say nothing: a setting, not a secret.
const plain = new Set([
  "true",
  "false",
  "null",
  "none",
  "nil",
  "undefined",
  "yes",
  "no",
  "on",
  "off",
  "required",
  "optional",
  "id",
  "name",
  "default",
  "auto",
  "string",
  "number",
  "bpe",
])
// Code that goes on to get the value from somewhere: bare values, in code's own case.
const codeWords = new Set([
  "await",
  "async",
  "new",
  "function",
  "require",
  "import",
  "return",
  "this",
  "self",
])

const sounds = (name: string): boolean => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const last = words.at(-1)
  // npm's `_auth` is a credential; a plain `auth` or `SSH_AUTH_SOCK` is not.
  if (/(^|_)_auth$/i.test(name) || /^_auth$/i.test(name)) return true
  if (last !== undefined && notSecret.has(last)) return last === "id" && words.includes("private")
  if (words.some((word) => secretInside.test(word))) return true
  if (words.some((word) => secretWords.has(word))) return true
  return words.some((word, index) => word === "key" && keyOf.has(words[index - 1] ?? ""))
}

// Whether `value` is worth hiding: not a path, a short number or a word like `true`.
const secretValue = (value: string, code = false): boolean => {
  if (code && codeWords.has(value)) return false
  const bare = value.replace(/^\\?["']|\\?["']$/g, "").trim()
  if (bare === "" || bare.includes(sentinel) || bare.includes(redacted)) return false
  if (/^[/~]|^\.\.?\//.test(bare)) return false
  if (/^\d{1,7}$/.test(bare)) return false
  // A reference, a placeholder or code that reads a secret from elsewhere is not one.
  if (/^(\$|<|\{\{|%[A-Za-z_]+%)/.test(bare)) return false
  if (/process\.env|os\.environ|import\.meta|getenv|secrets\./.test(bare)) return false
  if (/^[A-Za-z_][\w.]*\(/.test(bare)) return false
  if (/^[A-Za-z_]+(?:\.[A-Za-z_]+)+[,;)]?$/.test(bare)) return false
  return !plain.has(bare.toLowerCase())
}

// Whether a short stretch of a run looks like key material: both cases of letter, and no word.
const keyLike = (piece: string): boolean =>
  /[a-z]/.test(piece) && /[A-Z]/.test(piece) && !/[a-z]{7}/.test(piece)

// Whether a run is a path: a fifth of what is between its slashes are words (random base64 has
// a slash every 64 characters or so, and sometimes a few lowercase letters between two of them).
const pathLike = (text: string): boolean => {
  if (!text.includes("/")) return false
  const parts = text.split("/")
  const words = parts.filter((part) => /^[a-z]{4,}$/.test(part)).length
  return words / parts.length >= 0.2
}

// A run is judged by what most of it looks like, in pieces of this many characters: a word
// anywhere in a key's thousands of characters (random base64 has a run of 7 lowercase letters
// about every 550 characters) must not leave it visible. A run of four pieces or more may have
// a third of them fail, if digits are a good share of it, as they are in base64 (one in six)
// and not in identifiers.
const piece = 20

const qualifies = (text: string): boolean => {
  if (text.length < 40 || !/[a-z]/.test(text) || !/[A-Z]/.test(text) || pathLike(text)) return false
  const digits = text.replaceAll(/\D/g, "").length
  // Standard base64 has `+`, `/` and `=`, which words and identifiers don't.
  const marked = /[+/]|=$/.test(text)
  if (marked ? digits < 1 : digits < 3) return false
  if (!/[a-z]{7}/.test(text)) return true
  // A mangled C++ or Rust name is long, mixed in case and full of words, and no key; it never
  // holds base64's `-`, `+`, `/` or `=`, which a key of this length almost always does.
  // A stack frame's offset may be glued on (`_ZN…E+0x1a2`, `+0x4b/0x90`).
  if (
    /^_{1,2}(?:Z[A-Za-z0-9]|R[A-Z])/.test(text) &&
    !/[-+/=]/.test(text.replace(/\+0x[0-9a-f]+(?:\/0x[0-9a-f]+)?$/, ""))
  )
    return false
  const pieces = Math.floor(text.length / piece)
  if (pieces < 4 || digits < text.length / 20) return false
  let failing = 0
  for (let i = 0; i < pieces; i += 1)
    if (!keyLike(text.slice(i * piece, i === pieces - 1 ? text.length : (i + 1) * piece)))
      failing += 1
  return failing <= Math.floor(pieces / 3)
}

// Whether `value` opens a quote it never closes while the name before it sits inside an open
// string literal of the same kind: `print("password: " + user.password)`. There the quote closes
// the literal, and opens no value.
// (A replacer is handed the match's offset and the text after the groups, which its type allows.)
const closesLiteral = (value: string, offset: unknown, text: unknown): boolean => {
  const quote = value[0]
  if (quote !== '"' && quote !== "'") return false
  if (value.length > 1 && value.endsWith(quote)) return false
  const before = String(text).slice(0, Number(offset))
  let count = 0
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== quote) continue
    // An apostrophe inside a word (can't, user's) opens and closes nothing.
    if (
      quote === "'" &&
      /\p{L}/u.test(before[i - 1] ?? "") &&
      /\p{L}/u.test(String(text)[i + 1] ?? "")
    )
      continue
    count += 1
  }
  return count % 2 === 1
}

// The longest value a rule takes whole at once; a secret that reaches it is masked to the end of its run.
const valueCap = 1024

// A quoted value; one opened and never closed runs to the end of the line. A string inside
// JSON that is itself in a string has its quotes escaped.
const quoted = `\\\\"(?:[^\\\\\\n]|\\\\(?!"))*\\\\"|"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|"[^\\n]*|'[^\\n]*`

const rules: readonly Rule[] = [
  // A key block, or the start of one whose end scrolled away.
  [/-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(-----END [A-Z0-9 ]*-----|$)/g, hide],
  // Tokens with a prefix of their own.
  [new RegExp(`(?<![\\w])${spaced("sk-")}${wrapped(url, 6)}`, "g"), mask],
  [new RegExp(`(?<![\\w])[sr]k_(?:live|test)_${wrapped("A-Za-z0-9", 8)}`, "g"), mask],
  [new RegExp(`(?<![\\w])gh[pousr]_${wrapped("A-Za-z0-9", 4)}`, "g"), mask],
  [new RegExp(`(?<![\\w])${spaced("github_pat_")}${wrapped("A-Za-z0-9_", 10)}`, "g"), mask],
  [new RegExp(`(?<![\\w])${spaced("glpat-")}${wrapped(url, 10)}`, "g"), mask],
  [new RegExp(`(?<![\\w])${spaced("hf_")}${wrapped("A-Za-z0-9", 16)}`, "g"), mask],
  [new RegExp(`(?<![\\w])${spaced("hvs.")}${wrapped(`${url}.`, 20)}`, "g"), mask],
  [new RegExp(`(?<![\\w])${spaced("npm_")}${wrapped("A-Za-z0-9", 20)}`, "g"), mask],
  [new RegExp(`(?<![\\w])${spaced("pypi-")}${wrapped("A-Za-z0-9_=-", 20)}`, "g"), mask],
  [new RegExp(`(?<![\\w])ya29\\.(?=[A-Za-z0-9_.-]*[A-Z0-9])${wrapped(`${url}.`, 20)}`, "g"), mask],
  [new RegExp(`(?<![\\w])${spaced("AIza")}${wrapped(url, 30)}`, "g"), mask],
  [new RegExp(`(?<![\\w])SG\\.${wrapped(url, 16)}\\.${wrapped(url, 16)}`, "g"), mask],
  // A Discord bot token: three parts, the first the user id's digits in base64.
  [
    /(?<![\w.-])([A-Za-z0-9_-]{18,32})\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}/g,
    (all, id) => (/^\d{17,20}$/.test(decoded(id)) ? hide(all) : all),
  ],
  [new RegExp(`${spaced("AGE-SECRET-KEY-1")}${wrapped("A-Z0-9", 20)}`, "g"), mask],
  // Skipped only when more capitals end the word (a placeholder). A secret glued on, which may
  // start with a capital or a digit, is masked with the id, since what is left of it after the
  // id may not look like a secret on its own.
  [
    new RegExp(
      `(?<![\\w])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z]+(?![0-9A-Za-z+/]))[0-9A-Za-z+/]*=*`,
      "g",
    ),
    mask,
  ],
  [new RegExp(`(?<![\\w])xox[abeoprs]-${wrapped("A-Za-z0-9-", 10)}`, "g"), mask],
  [new RegExp(`(?<![\\w])eyJ[\\w-]{8,}\\.[\\w-]{8,}\\.[\\w-]*`, "g"), mask],
  // Webhooks carry their secret in the path.
  [
    /(hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/webhooks\/)([^\s"'<>]+)/gi,
    (_all, host, rest) => `${host}${hide(rest)}`,
  ],
  // user:password@host in any URL, even with no user.
  [
    /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/@:]*:[^\s/]*)@/gi,
    (_all, scheme, info) => `${scheme}${hide(info)}@`,
  ],
  // A key as the whole userinfo, as Sentry's DSN has it.
  [
    /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([A-Za-z0-9]{16,}|[A-Za-z0-9]{12,}(?=@[^\s/]*(?:sentry|ingest)))@/gi,
    (_all, scheme, key) => `${scheme}${hide(key)}@`,
  ],
  // A secret in a URL's query.
  [
    /([?&])([\w.-]+)=([^&\s#]+)/g,
    (all, joint, name, value) =>
      sounds(name) && secretValue(value) ? `${joint}${name}=${hide(value)}` : all,
  ],
  // Whole headers: the credential is everything after the name.
  [
    /\b(Authorization\s*[:=]\s*(?:(?:Bearer|Basic|Token|Digest)\s+)?)(?!\uE000)(\S+)/gi,
    (_all, head, value) => `${head}${hide(value)}`,
  ],
  [/\b((?:Set-)?Cookie\s*:[ \t]*)([^\n]+)/gi, (_all, head, value) => `${head}${hide(value)}`],
  [
    /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{4,})/gi,
    (all, scheme, gap, value) =>
      /\d/.test(value) || value.length >= 16 ? `${scheme}${gap}${hide(value)}` : all,
  ],
  // aws configure asks for the key by name.
  [
    /(\bSecret Access Key[^:\n]{0,64}:[ \t]*)(\S+)/gi,
    (_all, head, value) => `${head}${hide(value)}`,
  ],
  // AUTH=Basic dXNlcjpwYXNz, where the scheme says it is a credential.
  [
    /([=:][ \t]*(?:Basic|Bearer)[ \t]+)([A-Za-z0-9+/=._~-]{8,})/g,
    (_all, head, value) => `${head}${hide(value)}`,
  ],
  // Command lines that take a password in their own way.
  [
    /(\bredis-cli\b[^\n]{0,256}?\s-a\s+)(?!-)(\S+)/g,
    (_all, head, value) => `${head}${hide(value)}`,
  ],
  [
    /(\bhtpasswd\b[^\n]{0,256}?\s-\w*b\w*\s+\S+\s+\S+\s+)(\S+)/g,
    (_all, head, value) => `${head}${hide(value)}`,
  ],
  [/(\bopenssl\b[^\n]{0,256}?\s-k\s+)(?!-)(\S+)/g, (_all, head, value) => `${head}${hide(value)}`],
  [
    /(\bopenssl\b[^\n]{0,256}?\s-pass(?:in|out)?\s+pass:)(\S+)/g,
    (_all, head, value) => `${head}${hide(value)}`,
  ],
  [
    /(\b(?:mysql|mysqladmin|mysqldump)\w*\b[^\n]{0,256}?\s-p)(?=\S)(\S+)/g,
    (_all, head, value) => `${head}${hide(value)}`,
  ],
  [
    /(\b(?:docker\s+login|sshpass)\b[^\n]{0,256}?\s-p\s+)(?!-)(\S+)/g,
    (_all, head, value) => `${head}${hide(value)}`,
  ],
  [
    /(\bcurl\b[^\n]{0,256}?\s(?:-u|--user)[ =]\s*)(?!-)(\S+)/g,
    (_all, head, value) => `${head}${hide(value)}`,
  ],
  // --password hunter2, by the flag's exact name.
  [
    new RegExp(
      `(--(?:password|passwd|pass|pwd|token|auth-token|access-token|api-key|apikey|secret|client-secret|auth|bearer|credentials?|passphrase)(?:=|[ \\t]+))(?!-)(${quoted}|\\S+)`,
      "gi",
    ),
    (all, head, value, offset, text) =>
      secretValue(value) && !closesLiteral(value, offset, text)
        ? `${head}${hideValue(value)}`
        : all,
    true,
  ],
  // NAME=value, where the name sounds secret.
  [
    new RegExp(`(?<![\\p{L}\\p{N}_.-])([\\p{L}_][\\p{L}\\p{N}_.-]*)([ \\t]*=[ \\t]*)`, "gu"),
    (all, name, joint, value, offset, text) =>
      sounds(name) && secretValue(value, true) && !closesLiteral(value, offset, text)
        ? `${name}${joint}${hideValue(value)}`
        : all,
    new RegExp(`${quoted}|[^\\s"',;&]{1,${valueCap}}`, "uy"),
    1,
  ],
  // Polish: hasło: tajne, haslo=tajne
  [
    new RegExp(`(?<![\\p{L}])(has[lł]o|has[lł]a)([ \\t]*[:=][ \\t]*)(${quoted}|\\S+)`, "giu"),
    (all, name, joint, value, offset, text) =>
      secretValue(value) && !closesLiteral(value, offset, text)
        ? `${name}${joint}${hideValue(value)}`
        : all,
    true,
  ],
  // fish: set -x NAME value
  [
    /(\bset[ \t]+(?:-\w+[ \t]+)*)([A-Za-z_]\w*)([ \t]+)(?!-)(\S+)/g,
    (all, head, name, gap, value) =>
      sounds(name) && secretValue(value) ? `${head}${name}${gap}${hide(value)}` : all,
    true,
  ],
  // "name": "value", as JSON has it, and 'name': 'value'; in a string of a log line the
  // quotes are escaped: {\"name\":\"value\"}.
  [
    new RegExp(`(\\\\?)(["'])([\\p{L}_][\\p{L}\\p{N}_.-]*)\\1\\2([ \\t]*:[ \\t]*)`, "gu"),
    (all, slash, quote, name, joint, value, offset, text) =>
      sounds(name) && secretValue(value) && !closesLiteral(value, offset, text)
        ? `${slash}${quote}${name}${slash}${quote}${joint}${hideValue(value)}`
        : all,
    new RegExp(`${quoted}|[^\\s,}\\]]+`, "uy"),
    3,
  ],
  // name: value, as YAML and headers have it.
  [
    new RegExp(`(?<![\\p{L}\\p{N}_.-])([\\p{L}_][\\p{L}\\p{N}_.-]*)([ \\t]*:[ \\t]+)`, "gu"),
    (all, name, joint, value, offset, text) =>
      sounds(name) && secretValue(value, true) && !closesLiteral(value, offset, text)
        ? `${name}${joint}${hideValue(value)}`
        : all,
    new RegExp(`${quoted}|[^\\s"',;]{1,${valueCap}}`, "uy"),
    1,
  ],
  // A hash of a secret is as good as the secret; a commit id or a file's checksum is not one.
  [
    /(?<![0-9a-zA-Z_])(?<!sha(?:1|256|512)[:-])(?<!commit )(?<!diff-)[0-9a-f]{32,}(?![0-9a-zA-Z_])(?!\s{2}\S)/gi,
    (run) => (run.length === 40 || run.length === 44 ? run : hide(run)),
  ],
  // Base64 long enough to hold a key. Paths, words and identifiers are long and mixed too:
  // a run needs digits and no long word in it, and is never part of a path.
  [
    /(?<![\w/\\.+=-])(?<!;base64,)(?!sha(?:1|256|384|512)-)[A-Za-z0-9+/_-]{40,}={0,2}(?![\w\\+-]|\.[\w\\.+-])/g,
    (run) => (qualifies(run) ? hide(run) : run),
  ],
]

const scan = (
  text: string,
  pattern: RegExp,
  replace: Replacer,
  valuePattern?: RegExp,
  nameGroup = 1,
): string => {
  let result = ""
  let last = 0
  pattern.lastIndex = 0
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    if (valuePattern) {
      if (!sounds(found[nameGroup] ?? "")) continue
      valuePattern.lastIndex = pattern.lastIndex
      const value = valuePattern.exec(text)?.[0]
      if (value === undefined) continue
      found[0] += value
      found.push(value)
      pattern.lastIndex += value.length
    }
    const replaced = (replace as (...args: unknown[]) => string)(...found, found.index, text)
    if (replaced === found[0]) {
      // Look again from the match's value, the last thing in it: past the name, so that a
      // name which is no secret cannot hide one in its value, and never into the middle of a
      // character that takes two code units, where the same match would come back for ever.
      const value = [...found].toReversed().find((group) => group !== undefined) ?? ""
      let next = Math.max(found.index + 1, found.index + found[0].length - value.length)
      const unit = text.charCodeAt(next)
      if (unit >= 0xdc00 && unit <= 0xdfff) next += 1
      pattern.lastIndex = next
      continue
    }
    if (found[0] === "") pattern.lastIndex += 1
    let end = found.index + found[0].length
    let masked = replaced
    // A value that reached the cap goes on to the end of its run, and so does its mask.
    const value = [...found].toReversed().find((group) => group !== undefined) ?? ""
    if (value.length >= valueCap) {
      const tail = /^[^\s"',;&]*/.exec(text.slice(end))?.[0] ?? ""
      masked += hide(tail)
      end += tail.length
    }
    result += text.slice(last, found.index) + masked
    last = end
  }
  return result + text.slice(last)
}

/** `text` with each secret's characters replaced by sentinels, so it keeps its length. */
const mark = (text: string): string => {
  let result = text.replaceAll(sentinel, "?")
  for (const [pattern, replacement, again, name] of rules)
    result = again
      ? scan(result, pattern, replacement, again === true ? undefined : again, name)
      : result.replace(pattern, replacement)
  return result
}

// Each run of marks, with the newlines between marks it spans, as one mask.
const render = (marked: string, placeholder = redacted): string =>
  marked.replaceAll(new RegExp(`${sentinel}(?:\\n*${sentinel})*`, "g"), placeholder)

/**
 * A redactor that writes each secret, and each run of secrets with only newlines between them,
 * as `placeholder`.
 */
export const redactAs =
  (placeholder: string) =>
  (text: string): string =>
    render(mark(text), placeholder)

/** `text` with each secret written as `[redacted]`. */
export const redact = redactAs(redacted)

/** The pieces of `text` that `redact` masks, for a check on what was masked. */
export const maskedSpans = (text: string): string[] => {
  const marked = mark(text)
  return [...marked.matchAll(new RegExp(`${sentinel}(?:\\n*${sentinel})*`, "g"))].map((match) =>
    text.slice(match.index, match.index + match[0].length),
  )
}

// Which rows of the screen a key block covers: every row from a BEGIN marker to its END marker,
// or to the end of the screen if that is not visible. A marker may be split by the end of a
// row, so rows that go on in the next are read together; the whole group is covered.
const keyBlockRows = (screen: readonly string[], continues: readonly boolean[]): boolean[] => {
  const covered: boolean[] = screen.map(() => false)
  let inside = false
  for (let first = 0; first < screen.length;) {
    let last = first
    while (continues[last] && last + 1 < screen.length) last += 1
    const text = screen.slice(first, last + 1).join("")
    // A marker cut short by the pane's width still starts or ends a block: its dashes may be
    // on the next row, or lost. Whichever comes last in the group says if a block is open.
    const lastBegin = text.lastIndexOf("-----BEGIN")
    const lastEnd = text.lastIndexOf("-----END")
    if (lastEnd >= 0 && !inside && lastBegin < 0) {
      // An END with no BEGIN on screen: its block began above the top.
      for (let i = 0; i <= last; i += 1) covered[i] = true
    } else if (inside || lastBegin >= 0) {
      for (let i = first; i <= last; i += 1) covered[i] = true
    }
    if (lastBegin >= 0 || lastEnd >= 0) inside = lastBegin > lastEnd
    first = last + 1
  }
  return covered
}

// How much text is read together from a row's start: rows from there on, until they add up to
// this many characters. A rule needs at most a value (`valueCap`) with its name or prefix whole,
// so 4 times that holds any match with room to spare. A longer secret is masked whole all the
// same: a mask that reaches the window's end goes on through the characters a token is made of,
// and windows start at every row, so they overlap along it. The work on a group of any size is
// bounded to a window for each row, instead of all the rows after it.
const readWindow = 4 * valueCap
// What a token, a key or a hash is made of.
const tokenCharacter = /[\w.+/=~-]/
// The starts of tokens that have a prefix of their own (see the rules), and how long a run of
// token characters after one has to be to be masked on that alone: too long for a window to
// hold the whole token, which a rule needs to match it.
const tokenStart = new RegExp(
  `(?:eyJ|sk-|[sr]k_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|hf_|hvs\\.|npm_|pypi-|ya29\\.|AIza|SG\\.|xox[abeoprs]-|AGE-SECRET-KEY-1)`,
  "y",
)
const longToken = readWindow / 2

// Which characters of the screen's rows are a secret. Rows that go on (each but the last of a
// group ended at the pane's edge) are marked apart, as one text from the first of them, and as
// one text of a window (see `readWindow`) from each of their starts, and what any of those
// marks is masked, in whichever row it lies: a secret across a boundary is masked on both sides
// of it, even when the row before it ended in a word character, and a row's own context changes
// nothing else. A long token with a prefix is masked whole on its own (see `longToken`).
// Marking keeps lengths, so the readings line up character for character. Rows `skip` says are
// masked already are not read.
// Nothing here bounds a single reading: a caller that needs a bound runs it in a worker.
const markedRows = (
  rows: readonly string[],
  continues: readonly boolean[],
  skip: readonly boolean[],
): boolean[][] => {
  const result: boolean[][] = []
  for (let first = 0; first < rows.length;) {
    let last = first
    while (continues[last] && last + 1 < rows.length) last += 1
    const group = rows.slice(first, last + 1)
    if (skip[first]) {
      for (const row of group) result.push(Array.from({ length: row.length }, () => false))
    } else if (group.length === 1) {
      const marked = mark(group[0] ?? "")
      result.push(Array.from({ length: marked.length }, (_, i) => marked[i] === sentinel))
    } else {
      const text = group.join("")
      const masked: boolean[] = Array.from({ length: text.length }, () => false)
      // A token with a prefix, longer than a window reads, at the start of a row (where the
      // rule's boundary may be hidden by the row before) or after a boundary, is masked whole.
      // The end of the run a prefix is in is found once for all the prefixes in it.
      let run = 0
      for (let at = 0, row = 0; row < group.length; at += group[row++]?.length ?? 0) {
        for (let found = Math.max(at, run); found < at + (group[row]?.length ?? 0); found += 1) {
          if (found !== at && /\w/.test(text[found - 1] ?? "")) continue
          tokenStart.lastIndex = found
          if (!tokenStart.test(text)) continue
          let end = found
          while (end < text.length && tokenCharacter.test(text[end] ?? "")) end += 1
          // Short, or not: a prefix inside this run is in the same run.
          run = end
          if (end - found >= longToken) for (let i = found; i < end; i += 1) masked[i] = true
          found = end
        }
      }
      const note = (marked: string, from: number): void => {
        for (let i = 0; i < marked.length; i += 1)
          if (marked[i] === sentinel) masked[from + i] = true
      }
      let from = 0
      // Where the last carry went to, so that the next does not go over the same run again.
      let carried = 0
      for (let start = 0; start < group.length; start += 1) {
        note(mark(group[start] ?? ""), from)
        // The whole group from its first row; from each later start, a window of rows.
        let end = start + 1
        if (start === 0) end = group.length
        else {
          let size = group[start]?.length ?? 0
          while (end < group.length && size < readWindow) size += group[end++]?.length ?? 0
        }
        const marked = mark(group.slice(start, end).join(""))
        note(marked, from)
        // A mask that fills most of the window and runs to its end goes on through the rest of
        // its run, as a value that reaches `valueCap` does: a secret longer than the window is
        // masked whole. (A short one that ends where the window does is not carried on.)
        let length = 0
        while (length < marked.length && marked[marked.length - 1 - length] === sentinel)
          length += 1
        const reach = from + marked.length
        if (end < group.length && length >= longToken && reach >= carried) {
          let at = reach
          while (at < text.length && tokenCharacter.test(text[at] ?? "")) masked[at++] = true
          carried = at
        }
        from += (group[start] ?? "").length
      }
      let offset = 0
      for (const row of group) {
        result.push(masked.slice(offset, offset + row.length))
        offset += row.length
      }
    }
    first = last + 1
  }
  return result
}

// A row that holds the sentinel itself could not be told from a mask.
const clean = (screen: readonly string[]): string[] =>
  screen.map((row) => row.replaceAll(sentinel, "?"))

/**
 * Which UTF-16 units of a screen's rows are secret, one array of flags per row, as long as the
 * row. Rows are read as `redactScreen` reads them: each on its own and, where it runs to the
 * pane's edge (`continues`), with the rows that go on from it; a key block flags every unit of
 * every row it covers, to the end of the screen when its end is not on it.
 */
export const maskScreen = (
  screen: readonly string[],
  continues: readonly boolean[],
): boolean[][] => {
  const covered = keyBlockRows(screen, continues)
  const marked = markedRows(clean(screen), continues, covered)
  return marked.map((row, i) => (covered[i] ? row.map(() => true) : row))
}

/**
 * A screen's rows with their secrets masked, each row on its own and, where it runs to the
 * pane's edge (`continues`), read with the rows that go on from it; a key block masks every
 * row it covers, to the end of the screen when its end is not on it.
 */
export const redactScreen = (
  screen: readonly string[],
  continues: readonly boolean[],
): string[] => {
  const covered = keyBlockRows(screen, continues)
  const rows = clean(screen)
  const masked = markedRows(rows, continues, covered)
  return rows.map((row, i) =>
    covered[i]
      ? redacted
      : render(
          Array.from({ length: row.length }, (_, at) =>
            masked[i]?.[at] ? sentinel : row[at],
          ).join(""),
        ),
  )
}
