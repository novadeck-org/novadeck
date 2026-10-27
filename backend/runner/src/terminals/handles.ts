/**
 * Terminal handles: the word a session gives each of its terminals, such as `moth`, by
 * which agents address it and people find it on screen as `@moth`. A session never gives
 * a word twice, so a handle names one terminal for as long as the session lasts.
 *
 * The words are the Night Flock: night-sky and neon-street glow, a street alias or two,
 * and night birds. Each is short, said as it is spelled, and rare in agent output and in
 * code, so `@moth` stands out where an agent mentions it. The best words come first; the
 * rules they follow are in handles.test.ts.
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
  "shiv",
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

/** The handles a session has given, and those of its terminals open now. */
export type HandleSession = {
  /** Every handle the session has given, its closed terminals' too. */
  readonly given: ReadonlySet<string>
  /** The handles of its terminals open now. */
  readonly open: readonly string[]
}

/**
 * The handle a session gives its next terminal: the best word it has never given,
 * preferring one whose first letter no terminal open there starts with (so a jump by
 * letter lands in one key), then one no terminal open in another session has (so a
 * list across sessions seldom shows the same word twice). Once every word is given,
 * the words come again with a number: `moth2`, then `moth3`.
 */
export const nextHandle = (session: HandleSession, elsewhere: ReadonlySet<string>): string => {
  const letters = new Set(session.open.map((handle) => handle[0]))
  for (let round = 1; ; round++) {
    const fresh = handleWords
      .map((word) => (round === 1 ? word : `${word}${round}`))
      .filter((handle) => !session.given.has(handle))
    if (fresh.length === 0) continue
    const best = (handle: string) =>
      (letters.has(handle[0]) ? 2 : 0) + (elsewhere.has(wordOf(handle)) ? 1 : 0)
    return fresh.reduce((chosen, handle) => (best(handle) < best(chosen) ? handle : chosen))
  }
}

/** A handle's word, without the number a later round gives it: `moth2` is `moth`. */
export const wordOf = (handle: string): string => handle.replace(/[0-9]+$/, "")

/** The handle an agent wrote, as `@moth`, `moth` or `@Moth`, the way sessions keep it. */
export const bareHandle = (written: string): string =>
  written.trim().replace(/^@/, "").trim().toLowerCase()

/** A handle as people and agents read it: `@moth`. */
export const mention = (handle: string): string => `@${handle}`
