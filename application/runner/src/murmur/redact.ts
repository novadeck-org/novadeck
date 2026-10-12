// Murmur reads terminal text, and terminals show secrets. These fixed rules strip what
// looks like one before the text reaches the model, by shape alone: nothing is learned or
// configured, so what leaves the machine's terminal is the same on every machine.
//
// A secret is first marked in place: each of its characters becomes a sentinel, so the text
// keeps its length and everything around the secret. Marking a screen's continued rows as one
// text and as separate rows then lines up character for character, and the union of the two
// is what is masked. Marks are rendered as `[redacted]` only at the end.
import type { Digest } from "./describer.js"

export const redacted = "[redacted]"

// A run of `characters` at least `min` long.
const wrapped = (characters: string, min: number): string => `[${characters}]{${min},}`
// A literal, ready for a pattern.
const spaced = (literal: string): string =>
  [...literal].map((character) => character.replace(/[.\\-]/g, "\\$&")).join("")
const url = "A-Za-z0-9_\\-"

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
// A rule with `true` after it looks again from the next character whenever it leaves a match
// as it was, since a name that is no secret must not hide one inside its value.
type Rule = readonly [RegExp, Replacer] | readonly [RegExp, Replacer, true]

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

const qualifies = (text: string): boolean => {
  if (text.length < 40 || !/[a-z]/.test(text) || !/[A-Z]/.test(text) || /[a-z]{7}/.test(text))
    return false
  const digits = text.replaceAll(/\D/g, "").length
  // Standard base64 has `+`, `/` and `=`, which words and identifiers don't. A path has words
  // between its slashes; a key's segments are not words.
  const marked = /[+/]|=$/.test(text)
  if (text.includes("/") && text.split("/").some((part) => /^[a-z]{4,}$/.test(part))) return false
  return marked ? digits >= 1 : digits >= 3
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
    (all, id) =>
      /^\d{17,20}$/.test(Buffer.from(id, "base64url").toString("utf8")) ? hide(all) : all,
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
    new RegExp(
      `(?<![\\p{L}\\p{N}_.-])([\\p{L}_][\\p{L}\\p{N}_.-]*)([ \\t]*=[ \\t]*)(${quoted}|[^\\s"',;&]{1,${valueCap}})`,
      "gu",
    ),
    (all, name, joint, value, offset, text) =>
      sounds(name) && secretValue(value, true) && !closesLiteral(value, offset, text)
        ? `${name}${joint}${hideValue(value)}`
        : all,
    true,
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
    new RegExp(
      `(\\\\?)(["'])([\\p{L}_][\\p{L}\\p{N}_.-]*)\\1\\2([ \\t]*:[ \\t]*)(${quoted}|[^\\s,}\\]]+)`,
      "gu",
    ),
    (all, slash, quote, name, joint, value, offset, text) =>
      sounds(name) && secretValue(value) && !closesLiteral(value, offset, text)
        ? `${slash}${quote}${name}${slash}${quote}${joint}${hideValue(value)}`
        : all,
    true,
  ],
  // name: value, as YAML and headers have it.
  [
    new RegExp(
      `(?<![\\p{L}\\p{N}_.-])([\\p{L}_][\\p{L}\\p{N}_.-]*)([ \\t]*:[ \\t]+)(${quoted}|[^\\s"',;]{1,${valueCap}})`,
      "gu",
    ),
    (all, name, joint, value, offset, text) =>
      sounds(name) && secretValue(value, true) && !closesLiteral(value, offset, text)
        ? `${name}${joint}${hideValue(value)}`
        : all,
    true,
  ],
  // A hash of a secret is as good as the secret; a commit id or a file's checksum is not one.
  [
    /(?<![0-9a-zA-Z_])(?<!sha(?:1|256|512)[:-])(?<!commit )(?<!diff-)[0-9a-f]{32,}(?![0-9a-zA-Z_])(?!\s{2}\S)/gi,
    (run) => (run.length === 40 || run.length === 44 ? run : hide(run)),
  ],
  // Base64 long enough to hold a key. Paths, words and identifiers are long and mixed too:
  // a run needs digits and no long word in it, and is never part of a path.
  [
    /(?<![\w/\\.+=-])(?<!;base64,)(?!sha(?:1|256|384|512)-)[A-Za-z0-9+/_-]{40,}={0,2}(?![\w\\.+-])/g,
    (run) => (qualifies(run) ? hide(run) : run),
  ],
]

const scan = (text: string, pattern: RegExp, replace: Replacer): string => {
  let result = ""
  let last = 0
  pattern.lastIndex = 0
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
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
  for (const [pattern, replacement, again] of rules)
    result = again ? scan(result, pattern, replacement) : result.replace(pattern, replacement)
  return result
}

// Each run of marks, with the newlines between marks it spans, as one mask.
const render = (marked: string): string =>
  marked.replaceAll(new RegExp(`${sentinel}(?:\\n*${sentinel})*`, "g"), redacted)

export const redact = (text: string): string => render(mark(text))

/** The pieces of `text` that `redact` masks, for a check on what was masked. */
export const maskedSpans = (text: string): string[] => {
  const marked = mark(text)
  return [...marked.matchAll(new RegExp(`${sentinel}(?:\\n*${sentinel})*`, "g"))].map((match) =>
    text.slice(match.index, match.index + match[0].length),
  )
}

// The screen's rows with a key block masked: every row from a BEGIN marker to its END marker,
// or to the end of the screen if that is not visible. A marker may be split by the end of a
// row, so rows that go on in the next are read together; the whole group is masked.
const maskKeyBlocks = (screen: readonly string[], continues: readonly boolean[]): string[] => {
  const rows = [...screen]
  let inside = false
  for (let first = 0; first < rows.length;) {
    let last = first
    while (continues[last] && last + 1 < rows.length) last += 1
    const text = rows.slice(first, last + 1).join("")
    // A marker cut short by the pane's width still starts or ends a block: its dashes may be
    // on the next row, or lost. Whichever comes last in the group says if a block is open.
    const lastBegin = text.lastIndexOf("-----BEGIN")
    const lastEnd = text.lastIndexOf("-----END")
    if (lastEnd >= 0 && !inside && lastBegin < 0) {
      // An END with no BEGIN on screen: its block began above the top.
      for (let i = 0; i <= last; i += 1) rows[i] = redacted
    } else if (inside || lastBegin >= 0) {
      for (let i = first; i <= last; i += 1) rows[i] = redacted
    }
    if (lastBegin >= 0 || lastEnd >= 0) inside = lastBegin > lastEnd
    first = last + 1
  }
  return rows
}

// Redacts the rows of a screen. Rows that go on (each but the last of a group ended at the
// pane's edge) are marked apart and as one text from each of their starts, and what any of
// those marks is masked, in whichever row it lies: a secret across a boundary is masked on both
// sides of it, even when the row before it ended in a word character, and a row's own context
// changes nothing else. Marking keeps lengths, so the readings line up character for character.
// The work is bounded by the worker that does it (see prepare.ts), not by cutting the reading.
const redactRows = (screen: readonly string[], continues: readonly boolean[]): string[] => {
  // A row that holds the sentinel itself could not be told from a mask.
  const rows = screen.map((row) => row.replaceAll(sentinel, "?"))
  const result: string[] = []
  for (let first = 0; first < rows.length;) {
    let last = first
    while (continues[last] && last + 1 < rows.length) last += 1
    const group = rows.slice(first, last + 1)
    if (group.length === 1) result.push(redact(group[0] ?? ""))
    else {
      const text = group.join("")
      const masked: boolean[] = Array.from({ length: text.length }, () => false)
      const note = (marked: string, from: number): void => {
        for (let i = 0; i < marked.length; i += 1)
          if (marked[i] === sentinel) masked[from + i] = true
      }
      let from = 0
      for (let start = 0; start < group.length; start += 1) {
        note(mark(group[start] ?? ""), from)
        note(mark(group.slice(start).join("")), from)
        from += (group[start] ?? "").length
      }
      let offset = 0
      for (const row of group) {
        let marked = ""
        for (let i = offset; i < offset + row.length; i += 1)
          marked += masked[i] ? sentinel : (text[i] ?? "")
        result.push(render(marked))
        offset += row.length
      }
    }
    first = last + 1
  }
  return result
}

/** The digest with every string run through `redact`. */
export const redactDigest = (digest: Digest): Digest => {
  const one = (text: string | null): string | null => (text === null ? null : redact(text))
  const previous = digest.previous && { title: redact(digest.previous.title) }
  if (digest.kind === "shell") {
    // Key blocks are masked whole, on the rows as they were drawn; then every row is seen on
    // its own, and, where it runs to the pane's edge, with the row that goes on from it.
    const continues = digest.continues ?? []
    const screen = redactRows(maskKeyBlocks(digest.screen, continues), continues)
    return {
      ...digest,
      project: one(digest.project),
      folder: one(digest.folder),
      command: one(digest.command),
      screen,
      previous,
    }
  }
  return {
    ...digest,
    harness: redact(digest.harness),
    project: one(digest.project),
    folder: one(digest.folder),
    branch: one(digest.branch),
    plan: one(digest.plan),
    folders: digest.folders.map(redact),
    prompts: digest.prompts.map(redact),
    reply: one(digest.reply),
    summary: one(digest.summary),
    previous,
  }
}
