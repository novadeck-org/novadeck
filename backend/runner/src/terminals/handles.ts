/**
 * Terminal handles: the word a session gives each of its terminals, such as `moth`, by
 * which agents address it and people find it on screen as `@moth`. A session never gives
 * a word twice, so a handle names one terminal for as long as the session lasts.
 *
 * The words are the Night Flock: night-sky and neon-street glow, a street alias or two,
 * and night birds. Each is short, said as it is spelled, and rare in agent output and in
 * code, so `@moth` stands out where an agent mentions it. The best words come first, and
 * each session draws them in its own order (see `handleOrder`); the rules they follow are
 * in handles.test.ts.
 */
export const handleWords: readonly string[] = [
  // The first words a session gives, one per first letter.
  "moth",
  "fox",
  "owl",
  "crow",
  "kite",
  "raven",
  "dusk",
  "volt",
  "haze",
  "lynx",
  "sable",
  "glint",
  "quill",
  "umbra",
  "plume",
  "blaze",
  "noir",
  "wisp",
  "jinx",
  "thorn",
  "aster",
  "ebony",
  "ibis",
  "xenon",
  "zenith",
  // The rest, for longer sessions.
  "cinder",
  "comet",
  "frost",
  "hawk",
  "mist",
  "onyx",
  "rift",
  "shrike",
  "vapor",
  "nebula",
  "lantern",
  "gale",
  "heron",
  "jade",
  "koi",
  "pike",
  "quartz",
  "starling",
  "nightjar",
  "flint",
  "hush",
  "lumen",
  "opal",
  "silk",
  "tusk",
  "vesper",
  "cobalt",
  "jackdaw",
  "nimbus",
  "sigil",
  "strobe",
  "soot",
  "vigil",
  "fog",
  "agate",
  "arcade",
  "eider",
  "nocturne",
  "bramble",
  "briar",
  "thistle",
  "mink",
  "stoat",
  "loris",
  "coyote",
  "newt",
  "panther",
  "civet",
  "pylon",
  "basalt",
  "garnet",
  "velvet",
  "twilight",
  "vinyl",
  "glimmer",
  "murk",
  "smog",
  "sleet",
  "dregs",
  "mech",
  "vole",
  "shrew",
  "wick",
  "husk",
  "fizz",
  "rook",
  "hex",
  "ronin",
  "egret",
]

/** The best words, one per first letter, that every session gives before the rest. */
const bestWords = 25

/** A 32-bit FNV-1a hash of the text, the seed of a session's order. */
const seedOf = (text: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  return hash >>> 0
}

/** Mulberry32: numbers in [0, 1), the same ones for the same seed. */
const randomFrom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let mixed = Math.imul(seed ^ (seed >>> 15), seed | 1)
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
}

const shuffled = <T>(items: readonly T[], random: () => number): T[] => {
  const order = [...items]
  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[order[index], order[other]] = [order[other]!, order[index]!]
  }
  return order
}

/** The hues the UI colours handles by, going round in the words' rank (see `hueOf` in its critters). */
const hues = 8

/**
 * The words dealt round the hues in one turn for the whole order, so eight in a row look
 * different, as in the list's own order. Each group of words is dealt in full rounds, a
 * word of each hue, each hue's words shuffled; what a group can't fill a round with leads
 * the next group's words of its hue (as the best words' fourth of one hue does), and the
 * last group deals all it has. The turn of hues is shuffled too.
 */
const dealt = (groups: readonly (readonly string[])[], random: () => number): string[] => {
  const turn = shuffled(
    Array.from({ length: hues }, (_, hue) => hue),
    random,
  )
  const order: string[] = []
  let left: readonly string[][] = turn.map(() => [])
  groups.forEach((words, index) => {
    const byHue = left.map((carried, hue) => [
      ...carried,
      ...shuffled(
        words.filter((word) => handleWords.indexOf(word) % hues === hue),
        random,
      ),
    ])
    const counts = byHue.map((each) => each.length)
    const rounds = index === groups.length - 1 ? Math.max(...counts) : Math.min(...counts)
    for (let round = 0; round < rounds; round++)
      for (const hue of turn) {
        const word = byHue[hue]!.shift()
        if (word !== undefined) order.push(word)
      }
    left = byHue
  })
  return order
}

/**
 * The order a session gives the words in: the best words, then the rest, dealt round the
 * hues (see `dealt`), so sessions don't all start with the same handles. The session's id
 * seeds it, so a session keeps its order across restarts.
 */
export const handleOrder = (sessionId: string): readonly string[] =>
  dealt(
    [handleWords.slice(0, bestWords), handleWords.slice(bestWords)],
    randomFrom(seedOf(sessionId)),
  )

/** The handles a session has given, and those of its terminals open now. */
export type HandleSession = {
  /** The order the session gives words in (see `handleOrder`). */
  readonly order: readonly string[]
  /** Every handle the session has given, its closed terminals' too. */
  readonly given: ReadonlySet<string>
  /** The handles of its terminals open now. */
  readonly open: readonly string[]
}

/** The letters later rounds add, the alphabet backwards, so the first reads `mothz`. */
const suffixLetters = "zyxwvutsrqponmlkjihgfedcba"

/**
 * The endings a round's letter skips besides its own, which read badly before it: `nimbusz`,
 * `foxz`, `koiy`. A round skips a word that ends in its letter too, as `fizz` in the `z` round.
 * Only the first three rounds have any: a session reaches the fourth after some 280 terminals.
 */
const clashes: Readonly<Record<string, string>> = { z: "sx", y: "i", x: "sz" }

/** Handles a round never gives, a word plus its letters making one no terminal should carry. */
const refused: ReadonlySet<string> = new Set(["pikey"])

/** Whether a round's suffix reads well after the word: the first round's empty one always does. */
const follows = (word: string, suffix: string): boolean => {
  const letter = suffix[0]
  if (letter === undefined) return true
  return !`${letter}${clashes[letter] ?? ""}`.includes(word.at(-1)!) && !refused.has(word + suffix)
}

/**
 * What a round adds to each word: nothing the first time, then `z`, `y` and on to `a`, then
 * `zz`, `zy` and so on, where the word takes it (see `follows`).
 */
const suffixOf = (round: number): string => {
  let suffix = ""
  for (let left = round - 1; left > 0; left = Math.floor(left / suffixLetters.length)) {
    left--
    suffix = suffixLetters[left % suffixLetters.length]! + suffix
  }
  return suffix
}

/**
 * The handle a session gives its next terminal: the first word in its order it has never
 * given, preferring one whose first letter no terminal open there starts with, so a jump
 * by letter lands in one key. Once every word is given, the words come again with a
 * letter from the end of the alphabet (see `suffixOf`): `mothz`, then `mothy`.
 */
export const nextHandle = (session: HandleSession): string => {
  if (session.order.length === 0) throw new Error("A session's order has no words to give.")
  const letters = new Set(session.open.map((handle) => handle[0]))
  for (let round = 1; ; round++) {
    const suffix = suffixOf(round)
    const fresh = session.order
      .filter((word) => follows(word, suffix))
      .map((word) => `${word}${suffix}`)
      .filter((handle) => !session.given.has(handle))
    if (fresh.length === 0) continue
    return fresh.find((handle) => !letters.has(handle[0])) ?? fresh[0]!
  }
}

/** The handle an agent wrote, as `@moth`, `moth` or `@Moth`, the way sessions keep it. */
export const bareHandle = (written: string): string =>
  written.trim().replace(/^@/, "").trim().toLowerCase()

/** A handle as people and agents read it: `@moth`. */
export const mention = (handle: string): string => `@${handle}`
