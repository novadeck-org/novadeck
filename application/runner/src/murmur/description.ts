// What the model writes is a guess in JSON. This keeps the guesses that fit a terminal's
// title bar, tidies them, and drops the rest, so nothing downstream checks again.
import type { Description } from "./describer.js"
import { maskedSpans, redacted } from "./redact.js"

export const titleWords = { min: 2, max: 6 }
export const titleCharacters = 48

/**
 * The titles the prompt shows as examples. A small model copies them onto terminals they
 * don't fit, so a title that is one of them is refused.
 */
export const exampleTitles = [
  "Rotating billing webhook keys",
  "Walidacja formularza rejestracji",
  "Awaria testów",
  "Following the nginx access log",
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
  const a = new Set(words(title))
  const b = new Set(words(example))
  const shared = [...a].filter((word) => b.has(word)).length
  if (shared === a.size && shared === b.size) return source === undefined || !present(a, source)
  if (source === undefined) return false
  return shared / new Set([...a, ...b]).size >= 0.75 && !present(a, source)
}

// Whether every word is somewhere in `source`, the lower-cased text the model was shown.
const present = (given: ReadonlySet<string>, source: string): boolean =>
  [...given].every((word) => source.includes(word))

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
export const spacelessCharacters = { min: 2, max: 16 }

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

/**
 * The title in `raw`, the model's reply, or undefined when it can't be used. `source` is
 * the text the model was shown, which tells a title that copies an example from one that
 * names the same work.
 */
export const parseDescription = (raw: string, source?: string): Description | undefined => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const { title } = value as Record<string, unknown>
  if (typeof title !== "string") return undefined

  const cleanTitle = plain(title).replace(/[.:;,\s]+$/, "")
  if (cleanTitle.length > titleCharacters) return undefined
  if (spaceless.test(cleanTitle)) {
    const characters = [...cleanTitle.replaceAll(/\s/g, "")].length
    if (characters < spacelessCharacters.min || characters > spacelessCharacters.max)
      return undefined
  } else {
    const count = cleanTitle === "" ? 0 : cleanTitle.split(" ").length
    if (count < titleWords.min || count > titleWords.max) return undefined
  }
  // A question, or a greeting or request echoed back, names nothing.
  if (cleanTitle.endsWith("?")) return undefined
  const given = words(cleanTitle)
  if (given.length > 0 && given.every((word) => chatWords.has(word))) return undefined
  if (spacelessChat.has(cleanTitle.replaceAll(/\s/g, ""))) return undefined
  const shown = source === undefined ? undefined : fold(source)
  // A provider's key is looked for in the title as the model wrote it as well: tidying turns
  // `_` into a space. Nothing else is, since markdown around a code name is no part of it.
  if (looksSecret(cleanTitle) || providerKeys.test(title.replaceAll(invisible, "")))
    return undefined
  if (exampleTitles.some((example) => copies(cleanTitle, example, shown))) return undefined
  return { title: cleanTitle }
}
