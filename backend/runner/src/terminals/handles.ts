/**
 * Terminal handles: the word a project gives each of its terminals, such as `moth`, by
 * which agents address it and people find it on screen as `@moth`. No two terminals of a
 * project share a handle for as long as both are there (terminals made before that rule
 * may, until they close), and a closed terminal's handle goes to a new terminal of the
 * project an hour after it closed, the one freed longest ago first (see `nextHandle`).
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

/** How long a handle rests after its terminal is gone before another may take it: an hour. */
export const handleCooldown = 60 * 60 * 1000

/** What a project's pool keeps of a handle it has given at least once. */
export type PooledHandle = {
  /**
   * When its last terminal went, in epoch milliseconds, and the cooldown runs from then.
   * Until one is known to go it is when the handle was given: a create that drew it and
   * has not ended, or that failed, holds it that long, and no terminal that closes
   * without being told of keeps it longer.
   */
  readonly freedAt: number
  /** The terminal that went then, or took the handle, which may take it back within the cooldown. */
  readonly freedBy: string | null
}

/** A project's handles, as the next terminal of one of its sessions draws from them. */
type HandleProject = {
  /** The order the session gives words in (see `handleOrder`). */
  readonly order: readonly string[]
  /** Every handle the project has given, held or freed. */
  readonly pool: ReadonlyMap<string, PooledHandle>
  /**
   * The handles something in the project holds now: a terminal, open, asleep or saved, or a
   * record still closing. Terminals made before handles were unique in a project may share
   * one; the handle is held while any does. (A create under way holds its handle by the
   * cooldown, from `freedAt`.)
   */
  readonly held: ReadonlySet<string>
  /** The handles of the session's terminals open now. */
  readonly open: readonly string[]
  /** The time, in epoch milliseconds. */
  readonly now: number
  /** How long a freed handle rests; an hour when omitted. */
  readonly cooldown?: number
}

/**
 * Whether the project may give the handle again: nothing holds it, and it was never given
 * or was freed a cooldown ago, or by this very terminal, which may take it back sooner.
 */
export const claimable = (
  handle: string,
  project: Pick<HandleProject, "pool" | "held" | "now" | "cooldown">,
  terminalId?: string,
): boolean => {
  if (project.held.has(handle)) return false
  const pooled = project.pool.get(handle)
  if (pooled === undefined) return true
  return (
    project.now - pooled.freedAt >= (project.cooldown ?? handleCooldown) ||
    (terminalId !== undefined && pooled.freedBy === terminalId)
  )
}

/** The letters later rounds add, the alphabet backwards, so the first reads `mothz`. */
const suffixLetters = "zyxwvutsrqponmlkjihgfedcba"

/**
 * The endings a round's letter skips besides its own, which read badly before it: `nimbusz`,
 * `foxz`, `koiy`. A round skips a word that ends in its letter too, as `fizz` in the `z` round.
 * Only z, y and x have any, a session reaching the `w` round after some 350 terminals; they
 * hold for the later rounds a suffix starts with them too, as `zy`.
 */
const clashes: Readonly<Record<string, string>> = { z: "sx", y: "i", x: "sz" }

/** Handles a round never gives: a word plus its letters making a slur, or a word for skin colour. */
const refused: ReadonlySet<string> = new Set(["pikey", "dusky", "sooty"])

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
 * The handle a project gives the next terminal of a session: the first word in the
 * session's order that the project has never given, preferring one whose first letter no
 * terminal open in the session starts with, so a jump by letter lands in one key. When
 * every word has been given, the one freed longest ago, once it has rested a cooldown
 * (`handleCooldown`). Only when every word is held or resting do the words come again with
 * a letter from the end of the alphabet (see `suffixOf`): `mothz`, then `mothy`, each
 * round drawn the same way. A handle anything in the project holds is never given.
 */
export const nextHandle = (project: HandleProject): string => {
  const { order, pool, open } = project
  if (order.length === 0) throw new Error("A session's order has no words to give.")
  const letters = new Set(open.map((handle) => handle[0]))
  for (let round = 1; ; round++) {
    const suffix = suffixOf(round)
    const handles = order
      .filter((word) => follows(word, suffix))
      .map((word) => `${word}${suffix}`)
      .filter((handle) => !project.held.has(handle))
    const fresh = handles.filter((handle) => !pool.has(handle))
    if (fresh.length > 0) return fresh.find((handle) => !letters.has(handle[0])) ?? fresh[0]!
    const freed = handles
      .filter((handle) => claimable(handle, project))
      .toSorted((a, b) => pool.get(a)!.freedAt - pool.get(b)!.freedAt)
    if (freed.length > 0) return freed[0]!
  }
}

/** The handle an agent wrote, as `@moth`, `moth` or `@Moth`, the way sessions keep it. */
export const bareHandle = (written: string): string =>
  written.trim().replace(/^@/, "").trim().toLowerCase()

/** A handle as people and agents read it: `@moth`. */
export const mention = (handle: string): string => `@${handle}`
