import { handle } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import {
  bareHandle,
  claimable,
  handleCooldown,
  handleOrder,
  handleWords,
  mention,
  nextHandle,
  type PooledHandle,
} from "./handles.js"

// Words no handle may be: agents and harnesses (`@goose` would read as the Goose agent),
// Novadeck's own names, shell and code vocabulary, Tailwind colours, and the words the
// frequency check against real agent transcripts turned down.
const refused = new Set(
  [
    ["claude", "codex", "gemini", "grok", "cursor", "copilot", "goose", "crush", "amp"],
    ["kilo", "roo", "droid", "pi", "orca", "warp", "zed", "aider", "cline", "opencode"],
    ["nova", "deck", "runner", "focus", "grid", "canvas", "inbox", "lead", "plan"],
    ["murmur", "phosphor", "coolant", "graphite", "amber"],
    ["run", "log", "bug", "cat", "echo", "root", "node", "pipe", "gem", "rust"],
    ["dart", "elm", "pip", "smoke", "pixel", "shell", "static", "ghost", "drift", "daemon"],
    ["proxy", "socket", "kernel", "chrome", "ash", "bat", "main", "test", "dev", "key"],
    ["slate", "zinc", "stone", "neutral", "gray", "red", "lime", "teal", "cyan", "sky"],
    ["indigo", "violet", "rose", "ink", "neon", "ember", "mirage", "aura", "kestrel"],
    ["wraith", "idle", "done", "ready", "busy", "calm", "zen"],
  ].flat(),
)

describe("handle words", () => {
  it("are lowercase letters, short enough for a title bar", () => {
    for (const word of handleWords) expect(word).toMatch(/^[a-z]{3,8}$/)
  })

  it("are each given once", () => {
    expect(new Set(handleWords).size).toBe(handleWords.length)
  })

  it("never begin another word, so typing one picks it alone", () => {
    for (const word of handleWords)
      expect(handleWords.filter((other) => other !== word && other.startsWith(word))).toEqual([])
  })

  it("keep clear of agents, Novadeck's own names and code vocabulary", () => {
    expect(handleWords.filter((word) => refused.has(word))).toEqual([])
  })

  it("give a session's first terminals a different first letter each", () => {
    const first = handleWords.slice(0, 25).map((word) => word[0])
    expect(new Set(first).size).toBe(first.length)
  })

  it("are all handles the protocol takes", () => {
    for (const word of handleWords) expect(handle.safeParse(word).success).toBe(true)
  })
})

describe("a session's order", () => {
  const sorted = (words: readonly string[]) => words.toSorted()

  it("gives the best words first, then the rest, in its own shuffle", () => {
    const order = handleOrder("session-1")
    const best = handleWords.slice(0, 25)
    // A full round of hues at a time: three of each, the best words' fourth of one hue
    // leading the rest's first round.
    expect(order.slice(0, 24).every((word) => best.includes(word))).toBe(true)
    expect(order.slice(0, 32)).toEqual(expect.arrayContaining(best))
    expect(sorted(order)).toEqual(sorted(handleWords))
  })

  it("deals the words round the UI's eight hues, so a session's first eight look different", () => {
    const hue = (word: string) => handleWords.indexOf(word) % 8
    for (let index = 0; index < 50; index++) {
      const order = handleOrder(`s${index}`)
      // Every eight in a row, across the best words and into the rest, as far as the list
      // has words of every hue left.
      for (let start = 0; start + 8 <= 80; start++)
        expect(new Set(order.slice(start, start + 8).map(hue)).size, `from ${start}`).toBe(8)
    }
  })

  it("stays the same for a session, so a restart keeps it", () => {
    expect(handleOrder("session-1")).toEqual(handleOrder("session-1"))
  })

  it("differs from one session to the next", () => {
    const firsts = new Set(Array.from({ length: 20 }, (_, index) => handleOrder(`s${index}`)[0]))
    expect(firsts.size).toBeGreaterThan(5)
    expect(handleOrder("session-1")).not.toEqual(handleOrder("session-2"))
  })
})

describe("the next handle", () => {
  const order = handleWords
  const hour = handleCooldown

  // A project's pool: `held` handles are given and held, `freed` ones went at the time.
  const draw = ({
    held = [],
    freed = {},
    open = [],
    now = 10 * hour,
    words = order,
  }: {
    held?: readonly string[]
    freed?: { [handle: string]: number }
    open?: readonly string[]
    now?: number
    words?: readonly string[]
  } = {}) =>
    nextHandle({
      order: words,
      pool: new Map<string, PooledHandle>([
        ...held.map((each) => [each, { freedAt: 0, freedBy: null }] as const),
        ...Object.entries(freed).map(
          ([each, freedAt]) => [each, { freedAt, freedBy: null }] as const,
        ),
      ]),
      held: new Set(held),
      open,
      now,
    })

  it("is the first word in the session's order the project has never given", () => {
    expect(draw()).toBe("moth")
    expect(draw({ held: ["moth"] })).toBe("fox")
    expect(draw({ words: ["owl", "moth"] })).toBe("owl")
  })

  it("never gives a word something in the project holds", () => {
    expect(draw({ held: ["moth", "fox"] })).toBe("owl")
    // Held though the pool never heard of it: a terminal or a closing record holds it.
    const held = new Set(["moth"])
    expect(nextHandle({ order, pool: new Map(), held, open: [], now: 0 })).toBe("fox")
  })

  it("prefers a first letter no open terminal starts with", () => {
    // mink is open, so moth, the first word left, gives way to owl.
    expect(draw({ held: ["fox", "mink"], open: ["mink"] })).toBe("owl")
  })

  it("refuses an order with no words, rather than looking forever", () => {
    expect(() => draw({ words: [] })).toThrow(/no words/)
  })

  it("still gives a word when every letter is taken", () => {
    const open = [..."abcdefghijklmnopqrstuvwxyz"].map((letter) => `${letter}zz`)
    expect(draw({ open })).toBe("moth")
  })

  it("gives a word never given before one freed, however long ago", () => {
    expect(draw({ freed: { moth: 0 } })).toBe("fox")
  })

  it("gives the word freed longest ago once every word is given, after its cooldown", () => {
    const freed = Object.fromEntries(handleWords.map((word, index) => [word, (index + 1) * 100]))
    // The first word in the order is not the oldest: owl went first.
    freed.owl = 1
    expect(draw({ freed, now: 0 + 100 * hour })).toBe("owl")
    expect(draw({ freed, held: ["owl"], now: 100 * hour })).toBe("moth")
  })

  it("keeps a freed word an hour: not at 59 minutes 59 seconds, at the hour", () => {
    const all = Object.fromEntries(handleWords.map((word) => [word, 1_000]))
    const justBefore = 1_000 + hour - 1
    // Every word is resting, so the next round begins with a letter.
    expect(draw({ freed: all, now: justBefore })).toBe("mothz")
    expect(draw({ freed: all, now: 1_000 + hour })).toBe("moth")
  })

  it("comes round again with a letter from the end of the alphabet only when every word is held or resting", () => {
    const given = [...handleWords]
    expect(draw({ held: given, freed: {} })).toBe("mothz")
    expect(draw({ held: [...given, "mothz"] })).toBe("owlz")
    // A word held and one resting: the round's own free word comes first.
    const first = handleWords.slice(0, -1)
    expect(draw({ held: first, freed: { egret: 5 * hour }, now: 6 * hour })).toBe("egret")
    expect(draw({ held: first, freed: { egret: 5 * hour }, now: 6 * hour - 1 })).toBe("mothz")
    const zRound = [...given, ...handleWords.map((word) => `${word}z`)]
    expect(draw({ held: zRound })).toBe("mothy")
  })

  it("takes a suffixed word freed long enough ago when its round has none the project never gave", () => {
    const freed = { mothz: 1_000 }
    expect(draw({ words: ["moth"], held: ["moth"], freed, now: 1_000 + hour })).toBe("mothz")
    // Still resting: the next round's word.
    expect(draw({ words: ["moth"], held: ["moth"], freed, now: 1_000 + hour - 1 })).toBe("mothy")
  })

  it("goes on to two letters after a, and never doubles a word's last letter", () => {
    const rounds = (words: readonly string[], count: number): string[] => {
      const given = new Set(words)
      for (let index = 0; index < count; index++) given.add(draw({ words, held: [...given] }))
      return [...given].slice(words.length)
    }
    expect(rounds(["moth"], 27)).toEqual([
      ..."zyxwvutsrqponmlkjigfedcba".split("").map((letter) => `moth${letter}`),
      "mothzz",
      "mothzy",
    ])
    expect(rounds(["fizz", "moth"], 4)).toEqual(["mothz", "fizzy", "mothy", "mothx"])
  })

  it("skips endings that read badly before a round's letter, and refused handles", () => {
    const zRound = (word: string) => draw({ words: [word], held: [word] })
    expect(["nimbus", "fox", "fizz", "koi", "pike", "owl"].map(zRound)).toEqual([
      "nimbusy",
      "foxy",
      "fizzy",
      "koiz",
      "pikez",
      "owlz",
    ])
    const held = ["koi", "koiz", "pike", "pikez"]
    expect(draw({ words: ["koi"], held })).toBe("koix")
    expect(draw({ words: ["pike"], held })).toBe("pikex")
    expect(draw({ words: ["dusk"], held: ["dusk", "duskz"] })).toBe("duskx")
  })
})

describe("claiming a handle", () => {
  const hour = handleCooldown
  const pool = new Map<string, PooledHandle>([
    ["moth", { freedAt: 1_000, freedBy: "t1" }],
    // Given at 5_000 and not known to go: it rests from then, as a create that failed does.
    ["fox", { freedAt: 5_000, freedBy: null }],
  ])

  it("is refused while anything holds it, even for the terminal that freed it", () => {
    expect(claimable("fox", { pool, held: new Set(["fox"]), now: 0 }, "t1")).toBe(false)
    expect(claimable("moth", { pool, held: new Set(["moth"]), now: 9 * hour }, "t1")).toBe(false)
  })

  it("waits out the cooldown for another terminal, not for the one that freed it", () => {
    const at = (now: number, id?: string) => claimable("moth", { pool, held: new Set(), now }, id)
    expect(at(1_000 + hour - 1, "t2")).toBe(false)
    expect(at(1_000 + hour - 1)).toBe(false)
    expect(at(1_000 + hour, "t2")).toBe(true)
    expect(at(1_001, "t1")).toBe(true)
  })

  it("holds a handle a create drew and never finished for a cooldown from the draw", () => {
    const at = (now: number) => claimable("fox", { pool, held: new Set(), now }, "t3")
    expect(at(5_000 + hour - 1)).toBe(false)
    expect(at(5_000 + hour)).toBe(true)
  })

  it("is open for a handle the pool never gave", () => {
    expect(claimable("owl", { pool, held: new Set(), now: 0 }, "t2")).toBe(true)
  })
})

describe("a handle as written", () => {
  it("is the same handle with or without its @", () => {
    expect(bareHandle("@moth")).toBe("moth")
    expect(bareHandle(" moth ")).toBe("moth")
    expect(bareHandle("@Moth")).toBe("moth")
    // Only the handle: nothing after it is dropped quietly, so a title or a second handle is refused.
    expect(bareHandle("@moth · api-server")).toBe("moth · api-server")
    expect(bareHandle("mothz")).toBe("mothz")
    expect(mention("moth")).toBe("@moth")
  })
})
