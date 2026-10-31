// What the model writes is a guess in JSON. This keeps the guesses that fit a terminal's
// title bar, tidies them, and drops the rest, so nothing downstream checks again.
import { maskedSpans, redacted } from "@novadeck/secrets"

import type { Description } from "./describer.js"

// A title is a short noun name, like a ticket or a branch: the prompt asks for one to three
// words, and the parser lets one more through, so a name a little long is kept, not lost.
export const titleWords = { min: 1, max: 4 }
export const titleCharacters = 32

/**
 * The titles the prompt shows as examples. A small model copies them onto terminals they
 * don't fit, so a title that is one of them is refused.
 */
export const exampleTitles = [
  "Webhook key rotation",
  "Walidacja rejestracji",
  "Awaria testów",
  "Nginx access log",
] as const

// Text as `words` sees it before it splits: lower case, accents stripped.
const fold = (text: string): string =>
  text.toLowerCase().normalize("NFKD").replaceAll(/\p{M}/gu, "")

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)

// Whether `title` copies `example`: all of the example's words, and nothing else (whatever
// the case), or, when `source` is given, nearly so with words that nothing in the digest
// says. A title of real work that happens to share words with an example stays.
const copies = (title: string, example: string, source: string | undefined): boolean => {
  const a = new Set(words(title).map(stemOf))
  const b = new Set(words(example).map(stemOf))
  const shared = [...a].filter((word) => b.has(word)).length
  if (shared === a.size && shared === b.size) return source === undefined || !present(a, source)
  if (source === undefined) return false
  // A piece of the example (a word dropped from it) copies it as well, unless the digest says it.
  if (a.size > 0 && shared === a.size) return !present(a, source)
  return shared / new Set([...a, ...b]).size >= 0.75 && !present(a, source)
}

// Whether every word is somewhere in `source`, the lower-cased text the model was shown.
const present = (given: ReadonlySet<string>, source: string): boolean => {
  // The digest's words, split where paths, versions and names are joined by punctuation
  // (`/var/log/access.log` says "access" and "log").
  const said = fold(source)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  // A word is said by the digest in any inflection: it shares its first five letters (or all of
  // a shorter word) with a word there, as "walidacja" does with "walidację".
  return [...given].every((word) => {
    const start = word.slice(0, 5)
    return said.some((other) => other.startsWith(start) || other === word)
  })
}

// What a person says to an agent, in English and Polish: a title made only of these words
// names no work. Entries are folded like the title's words, so accents don't matter.
const chatWords = new Set(
  [
    "hi hey hello hallo thanks thank you so much a lot very ok okay yes no sure please try again later",
    "now continue keep going go on ahead do it how is are it whats what up sounds good great cool nice",
    "i im me my we us the to for that this there then also bye goodbye morning evening",
    "czesc hej witaj dzieki dziekuje dziekuje bardzo za pomoc prosze ok tak nie dobrze super jeszcze raz",
    "sprobuj ponownie co tam slychac jak sie masz idzie ty ci ci mi dzien dobry do widzenia",
  ].flatMap((line) => words(line)),
)

// What the terminals side counts as no mission in a prompt, so that a title made of it alone
// names nothing either (kept in step with `filler` in terminals/descriptions.ts).
const moreChatWords = words(
  `hiya howdy yo greetings thx ty cheers k kk yeah yep yup nope nah fine awesome perfect lovely
  proceed pls other one an and with more next sorry lgtm done s sup hows doing u ur everyone all
  your well just really lots can could would will help m back today afternoon night welcome
  heja siema witam dobra dzięki dziękuję swietna świetna swietnie świetnie swietny świetny
  robota spoko leci ciebie proszę dalej kontynuuj znowu pa nara jasne jasno okej to ten
  ta inne inny drugi drugie jedno porządku`.replaceAll("\n", " "),
)
for (const word of moreChatWords) chatWords.add(word)

// Words that make a title say only that something is going on or was asked, never what, or
// only what the window is ("Terminal", which the model gave for a summary opening "Done:").
const workFiller = new Set(
  words(
    `help helping working work running finished finish waiting status question questions
    review reviewing updating update updates fixing fix fixes checking terminal terminals
    session sessions`,
  ),
)

// A title opens with these when the model fills it with a verb phrase: they go when real
// words remain ("Working on login" is "login"). "Fixing" stays: "Fixing login" is not "login".
const verbFillers = [
  "help with",
  "helping with",
  "working on",
  "work on",
  "review of",
  "reviewing",
  "updating",
]

// Greetings and thanks in scripts written without spaces.
const spacelessChat = new Set([
  "你好",
  "您好",
  "谢谢",
  "謝謝",
  "谢谢你",
  "多谢",
  "再见",
  "こんにちは",
  "こんばんは",
  "おはよう",
  "ありがとう",
  "ありがとうございます",
  "ありがとうございました",
  "안녕",
  "안녕하세요",
  "감사합니다",
  "สวัสดี",
  "ขอบคุณ",
])

// Scripts written without spaces: a title in one counts its characters, not its words.
const spaceless =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u
const spacelessCharacters = { min: 2, max: 10 }

const tidy = (text: string): string => text.replace(/\s+/g, " ").trim()

// Characters that show nothing or reorder what is shown: format characters (bidi overrides
// and isolates, zero-width spaces, the soft hyphen) and the C1 controls. A title
// is plain text, so they are dropped before anything looks at it. The zero-width non-joiner
// and joiner stay: Persian, Indic scripts and emoji sequences need them.
const invisible = /(?![\u200C\u200D])[\p{Cf}\u0080-\u009f]/gu

// Markdown the model sometimes wraps its words in; a terminal title shows it literally.
const plain = (text: string): string =>
  tidy(
    text
      .replaceAll(invisible, "")
      .replace(/[*_`#]+/g, " ")
      .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, ""),
  )

// Murmur reads text that may hold a secret that redaction missed, and writes a title that is
// shown on screen. A title with a token-like piece in it is refused whatever the input was.
// A piece is a part of a word between `-`, `.`, `/`, `@`, `:` and `_`, so names, versions and
// paths (`@novadeck/protocol`, `ubuntu-24.04`, `CVE-2024-3094`) fall apart into short pieces.
const entropy = (word: string): number => {
  const counts = new Map<string, number>()
  for (const character of word) counts.set(character, (counts.get(character) ?? 0) + 1)
  let total = 0
  for (const count of counts.values()) {
    const share = count / word.length
    total -= share * Math.log2(share)
  }
  return total
}

// What a provider's keys look like, in the shape they are documented to have: the prefix and
// then a contiguous run of the characters and length they use. A name that merely begins the
// same (`npm_config_cache`, `hf_hub_download`, `sk-learn`) has underscores or too little
// after it, so it is no key. Found anywhere in the title, however it is wrapped.
// What a provider's keys look like, in the shape they are documented to have: the prefix and
// then a random body. A random body mixes cases, and for most providers puts digits among
// letters; words in lower case (`hf_transfer`, `npm_lifecycle_event`, `sk-learn-contrib`) do not.
// The run needs 12 or more characters, since a title is 48 characters and keys get cut short
// in prose. Underscores in a name that is a word list (`npm_config_cache`) stop the match by
// themselves, except where a key's own body has them.
const randomBody = (prefix: string, digits: boolean, body = "[A-Za-z0-9]"): string =>
  `${prefix}(?=${body}*(?:[a-z][A-Z]|[A-Z][a-z]${digits ? "|\\d[A-Za-z]|[A-Za-z]\\d" : ""}))${body}{12,}`

const wide = "[A-Za-z0-9_-]"
const providerKeys = new RegExp(
  `(?<![A-Za-z0-9])(?:${[
    randomBody("(?:ghp|gho|ghu|ghs|ghr)_", true),
    randomBody("github_pat_", true, "[A-Za-z0-9_]"),
    randomBody("sk-", true, wide),
    randomBody("(?:sk|rk)_(?:live|test)_", true),
    randomBody("whsec_", true),
    randomBody("glpat-", true, wide),
    randomBody("hf_", false),
    randomBody("npm_", true),
    randomBody("pypi-", true, wide),
    randomBody("xox[abeoprs]-", true, "[A-Za-z0-9-]"),
    // Slack's are digits and hyphens in front.
    "xox[abeoprs]-[0-9-]{12,}",
    randomBody("ya29\\.", false, wide),
    `AIza(?:(?=[A-Za-z0-9_-]*\\d)|(?=[A-Za-z0-9_-]*(?:[a-z][A-Z]|[A-Z][a-z]))(?![A-Za-z0-9_-]*[a-z]{5}))[A-Za-z0-9_-]{12,}`,
    "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
    randomBody("SG\\.", true, wide),
    "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}",
    "shp(?:at|ca|ss)_[A-Za-z0-9]{32}",
    "dop_v1_[a-f0-9]{20,}",
    "AGE-SECRET-KEY-1[A-Z0-9]{20,}",
    "(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])",
  ].join("|")})`,
)

// 12 or more characters of letters and digits that read as no word: no run of lowercase
// letters that long, and as many different characters as a random string has; or 16 or more
// with three or more digits, whatever else, since words do not have them.
const randomLike = (piece: string): boolean =>
  piece.length >= 12 &&
  !spaceless.test(piece) &&
  /\d/.test(piece) &&
  /\p{L}/u.test(piece) &&
  !identifierLike(piece) &&
  ((!/[a-z]{5}/.test(piece) && entropy(piece) >= 3) ||
    (piece.length >= 16 && (piece.match(/\d/g) ?? []).length >= 3 && entropy(piece) >= 3))

// A name in code (`Float32Array`, `iPhone15ProMax`, `Ed25519PublicKey`): cut at the changes of
// case and at the digits, at least 60% of it is words and the numbers in them.
const identifierLike = (piece: string): boolean => {
  // Names in code mix cases or are in capitals; a run of lower case and digits is more often a key.
  if (!/\p{Lu}/u.test(piece)) return false
  const segments = piece
    .replaceAll(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replaceAll(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}]+/u)
    // A word: a capital or not and then lower case, 3 to 12 letters, with a vowel; or an
    // acronym of up to four capitals.
    .filter(
      (word) =>
        /[aeiouyAEIOUY]/.test(word) &&
        (/^\p{Lu}?\p{Ll}{2,11}$/u.test(word) || /^\p{Lu}{2,4}$/u.test(word)),
    )
  // The numbers in names (25519, 256, 32) are not random either: runs of two to five digits next to a word.
  const numbers = (
    piece.match(/(?<=\p{Ll}{3})\d{2,5}(?!\d)|(?<!\d)\d{2,5}(?=\p{Lu}\p{Ll}{2})/gu) ?? []
  ).reduce((sum, run) => sum + run.length, 0)
  const covered = segments.reduce((sum, word) => sum + word.length, 0) + numbers
  return covered * 5 >= piece.length * 3
}

// A hex string of a hash's length is a commit id in a log and a secret in a title.
const hexRun = /(?<![0-9a-z])[0-9a-f]{32,}(?![0-9a-z])/i

const tokenLike = (text: string): boolean =>
  hexRun.test(text) ||
  text.split(/\s+/).some((word) => word.split(/[-./@:_]+/).some((piece) => randomLike(piece)))

// A title is refused when it has a token-like piece, or when redaction masks a piece of it that
// is token-like or 12 or more characters with a digit. A colon phrase ("Fixing token: refresh
// bug") that redaction masks as a value is no secret: only what looks like one counts.
export const looksSecret = (title: string): boolean =>
  title.includes(redacted) ||
  providerKeys.test(title) ||
  tokenLike(title) ||
  maskedSpans(title).some(
    (span) => providerKeys.test(span) || tokenLike(span) || (span.length >= 12 && /\d/.test(span)),
  )

export type Limits = {
  readonly words: { readonly min: number; readonly max: number }
  readonly characters: number
  readonly spaceless: { readonly min: number; readonly max: number }
  readonly examples: readonly string[]
}

const titleLimits: Limits = {
  words: titleWords,
  characters: titleCharacters,
  spaceless: spacelessCharacters,
  examples: exampleTitles,
}

const object = (raw: string): Record<string, unknown> | undefined => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

// Words a name does not end or begin on once the project's name is gone from it:
// "UI polish for Novadeck" is "UI polish", not "UI polish for".
const joiners = new Set(
  [
    "for",
    "of",
    "in",
    "on",
    "at",
    "to",
    "with",
    "and",
    "the",
    "a",
    "an",
    "dla",
    "w",
    "na",
    "do",
    "i",
    "z",
  ].flatMap((word) => words(word)),
)

// Project names that are words of any work, not names of one: a title about "the app" or "the
// api" names the work, so these (and any name of three letters or fewer) are left in.
const genericProjects = new Set(
  "app api ui web server client docs doc test tests src core frontend backend site website cli lib".split(
    " ",
  ),
)

// A token without the punctuation around it, accents folded and in lower case.
const bare = (token: string): string =>
  fold(token).replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")

// Words that are written in lower case by design, and keep it at the start of a title.
const lowerByDesign = new Set(
  "pnpm npm npx yarn bun deno pip uv cargo gh kubectl tsc eslint vitest pytest jq curl vim nvim tmux htop ssh rsync zsh bash ffmpeg webpack".split(
    " ",
  ),
)

// What is left of a title that began with a capital after its start was cut off begins with
// one too, unless its first word is lower case by design (`pnpm`, `iOS`, `eBay`).
const capitalised = (rest: string, original: string): string => {
  const first = rest.split(" ")[0] ?? ""
  if (!/^\p{Lu}/u.test(original) || !/^\p{Ll}/u.test(first)) return rest
  if (/\p{Lu}/u.test(first.slice(1)) || lowerByDesign.has(first.toLowerCase())) return rest
  return first.charAt(0).toUpperCase() + rest.slice(1)
}

// The title without the project's name, which the person sits in already and is told by the
// window. Only the name as one token, as the folder spells it ("novadeck-website", in any
// case, also as a possessive: "Novadeck's"), is taken out: a name that is a generic word or very
// short is kept, and so is a title that spells it as several words, since taking those out
// mangles ordinary titles. What is left loses the joiners at its edges. Undefined when nothing
// else is left: such a title names nothing.
const withoutProject = (title: string, project: string | null | undefined): string | undefined => {
  const key = bare(project ?? "")
  if (key.length <= 3 || genericProjects.has(key)) return title
  const tokens = title.split(" ")
  const kept = tokens.filter((token) => bare(token).replace(/['\u2019]s$/, "") !== key)
  if (kept.length === tokens.length) return title
  while (joiners.has(words(kept[0] ?? "").join(""))) kept.shift()
  while (joiners.has(words(kept.at(-1) ?? "").join(""))) kept.pop()
  if (kept.length === 0) return undefined
  const rest = kept.join(" ")
  return kept[0] === tokens[0] ? rest : capitalised(rest, title)
}

// A title without a verb phrase's filler at its start, when words of its own remain.
const withoutFiller = (title: string): string => {
  const lower = title.toLowerCase()
  const filler = verbFillers.find((phrase) => lower.startsWith(`${phrase} `))
  return filler === undefined
    ? title
    : capitalised(title.slice(filler.length + 1).trimStart(), title)
}

// Words of any work, which say nothing of what a name is about.
const small = new Set(
  words(
    `new add my up from to of in on at by for with and the a an is it as or via into after before over under onto per set
    do na w z od dla i o po przy ze oraz nowy nowa
    der die das und mit von zu für im
    de la le les des du en el los las y con para por`,
  ),
)

// Light suffix stripping, so that "rotation", "rotating" and "rotates" meet and
// "transaction" and "translation" do not: the word without a plural, "ing", "ed", "ions"
// or "ion" when four letters or more are left, and without a final "e".
const stemOf = (word: string): string => {
  let stem = word
  for (const suffix of ["ions", "ion", "ing", "ed"])
    if (stem.endsWith(suffix) && stem.length - suffix.length >= 4) {
      stem = stem.slice(0, -suffix.length)
      break
    }
  if (/(?:ss|us|is)$/.test(stem)) return stem
  if (/(?:ch|sh|x|z|s)es$/.test(stem) && stem.length > 5) stem = stem.slice(0, -2)
  else if (stem.endsWith("s") && stem.length > 3) stem = stem.slice(0, -1)
  return stem.length > 4 && stem.endsWith("e") ? stem.slice(0, -1) : stem
}

// Generic names of work: "Fix login" and "Test login" are about login.
const generic = new Set(
  words(
    `test tests testing bug bugs fix fixing fixes fixed update updating updates error errors issue
    issues feature features refactor refactoring cleanup docs doc review reviewing setup support page pages`,
  ).map(stemOf),
)

// A ticket id such as EMO-118 is one word: EMO-118 and EMO-119 are different work.
const ticket = /\p{L}{2,}-\d+/gu

// What a name is about: its ticket ids whole and its other words in lower case, accents gone
// and cut to their stems, without the generic and the small; two letters written in capitals
// stay, as "UI", "CI" and "DB" are what some work is about, and other short words go.
const stems = (title: string): Set<string> => {
  const ids = fold(title).match(ticket) ?? []
  const found = new Set<string>(ids)
  for (const token of title.replaceAll(ticket, " ").match(/[\p{L}\p{N}]+/gu) ?? []) {
    const word = fold(token)
    const stem = stemOf(word)
    const acronym = /^\p{Lu}{2}$/u.test(token)
    if ((acronym || word.length >= 3) && !small.has(word) && !generic.has(stem)) found.add(stem)
  }
  return found
}

// Bigrams of a name in a script written without spaces, which has no words to compare. The
// bigrams of common words of work (fix, bug, test, in Chinese, Japanese and Korean) are no
// part of it.
const commonBigrams = new Set([
  "修复",
  "修正",
  "问题",
  "問題",
  "测试",
  "測試",
  "错误",
  "錯誤",
  "テス",
  "スト",
  "バグ",
  "エラ",
  "수정",
  "오류",
  "버그",
  "테스",
  "스트",
])
const bigrams = (title: string): Set<string> => {
  const letters = [...fold(title).replaceAll(/[^\p{L}\p{N}]/gu, "")]
  const pairs = new Set<string>()
  for (let at = 0; at + 1 < letters.length; at += 1) {
    const pair = `${letters[at]}${letters[at + 1]}`
    if (!commonBigrams.has(pair)) pairs.add(pair)
  }
  return pairs
}

/**
 * Whether two names share a content word: ticket ids whole, other words by their stems,
 * ignoring case, accents, the small words and generic names of work (fix, test, bug); for a
 * name in a script written without spaces, half of the shorter one's character pairs. Names that share none are about
 * different things.
 */
export const sharesContentWord = (a: string, b: string): boolean => {
  if (spaceless.test(a) || spaceless.test(b)) {
    // Pairs of characters are weaker than words: half of the shorter name's must be shared.
    const [first, second] = [bigrams(a), bigrams(b)]
    const shared = [...first].filter((pair) => second.has(pair)).length
    return shared > 0 && shared * 2 >= Math.min(first.size, second.size)
  }
  const other = stems(b)
  return [...stems(a)].some((stem) => other.has(stem))
}

// The line the model wrote, tidied, or undefined when it doesn't fit `limits`, names nothing,
// copies an example or looks like a secret. `source` is the text the model was shown, and
// `project` a name to leave out of it.
export const line = (
  text: string,
  limits: Limits,
  source: string | undefined,
  project?: string | null,
): string | undefined => {
  const tidied = plain(text).replace(/[.:;,\s]+$/, "")
  const stripped = withoutProject(tidied, project)
  if (stripped === undefined) return undefined
  const clean = withoutFiller(stripped)
  if (clean.length > limits.characters) return undefined
  if (spaceless.test(clean)) {
    const characters = [...clean.replaceAll(/\s/g, "")].length
    if (characters < limits.spaceless.min || characters > limits.spaceless.max) return undefined
  } else {
    const count = clean === "" ? 0 : clean.split(" ").length
    if (count < limits.words.min || count > limits.words.max) return undefined
  }
  // A question, or a greeting or request echoed back, names nothing.
  if (clean.endsWith("?")) return undefined
  const given = words(clean)
  if (given.length > 0 && given.every((word) => chatWords.has(word))) return undefined
  if (given.every((word) => workFiller.has(word) || chatWords.has(word))) return undefined
  if (spacelessChat.has(clean.replaceAll(/\s/g, ""))) return undefined
  const shown = source === undefined ? undefined : fold(source)
  // A provider's key is looked for in the line as the model wrote it as well: tidying turns
  // `_` into a space. Nothing else is, since markdown around a code name is no part of it.
  if (looksSecret(clean) || providerKeys.test(text.replaceAll(invisible, ""))) return undefined
  if (limits.examples.some((example) => copies(clean, example, shown))) return undefined
  return clean
}

/**
 * The title in `raw`, the model's reply, or undefined when it can't be used. `source` is
 * the text the model was shown, which tells a title that copies an example from one that
 * names the same work. `project` is the project's name, taken out of the title (it is
 * refused when nothing else is left).
 */
export const parseDescription = (
  raw: string,
  source?: string,
  project?: string | null,
): Description | undefined => {
  const value = object(raw)
  if (value === undefined) return undefined
  const { title } = value
  const clean = typeof title === "string" ? line(title, titleLimits, source, project) : undefined
  return clean === undefined ? undefined : { title: clean }
}
