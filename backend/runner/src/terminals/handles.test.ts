import { handle } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { bareHandle, handleOrder, handleWords, mention, nextHandle } from "./handles.js"

// Words no handle may be: agents and harnesses (`@goose` would read as the Goose agent),
// Novadeck's own names, shell and code vocabulary, Tailwind colours, and the words the
// frequency check against real agent transcripts turned down.
const refused = new Set(
  [
    ["claude", "codex", "gemini", "grok", "cursor", "copilot", "goose", "crush", "amp"],
    ["kilo", "roo", "droid", "pi", "orca", "warp", "zed", "aider", "cline", "opencode"],
    ["nova", "deck", "runner", "focus", "grid", "canvas", "inbox", "lead", "plan"],
    ["murmur", "phosphor", "graphite", "amber"],
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
  const none = new Set<string>()
  const order = handleWords

  it("is the first word in the session's order it has never given", () => {
    expect(nextHandle({ order, given: none, open: [] })).toBe("moth")
    expect(nextHandle({ order, given: new Set(["moth"]), open: [] })).toBe("fox")
    expect(nextHandle({ order: ["owl", "moth"], given: none, open: [] })).toBe("owl")
  })

  it("never gives a closed terminal's word again", () => {
    expect(nextHandle({ order, given: new Set(["moth", "fox"]), open: [] })).toBe("owl")
  })

  it("prefers a first letter no open terminal starts with", () => {
    // mink is open, so moth, the first word left, gives way to owl; fox, closed, never returns.
    expect(nextHandle({ order, given: new Set(["fox", "mink"]), open: ["mink"] })).toBe("owl")
  })

  it("refuses an order with no words, rather than looking forever", () => {
    expect(() => nextHandle({ order: [], given: none, open: [] })).toThrow(/no words/)
  })

  it("still gives a word when every letter is taken", () => {
    const open = [..."abcdefghijklmnopqrstuvwxyz"].map((letter) => `${letter}zz`)
    expect(nextHandle({ order, given: none, open })).toBe("moth")
  })

  it("comes round again with a letter from the end of the alphabet once every word is given", () => {
    const given = new Set(handleWords)
    expect(nextHandle({ order, given, open: [] })).toBe("mothz")
    expect(nextHandle({ order, given: new Set([...given, "mothz"]), open: [] })).toBe("owlz")
    const zRound = new Set([...given, ...handleWords.map((word) => `${word}z`)])
    expect(nextHandle({ order, given: zRound, open: [] })).toBe("mothy")
  })

  it("goes on to two letters after a, and never doubles a word's last letter", () => {
    const rounds = (words: readonly string[], count: number): string[] => {
      const given = new Set(words)
      for (let index = 0; index < count; index++)
        given.add(nextHandle({ order: words, given, open: [] }))
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
    const zRound = (word: string) => nextHandle({ order: [word], given: new Set([word]), open: [] })
    expect(["nimbus", "fox", "fizz", "koi", "pike", "owl"].map(zRound)).toEqual([
      "nimbusy",
      "foxy",
      "fizzy",
      "koiz",
      "pikez",
      "owlz",
    ])
    const given = new Set(["koi", "koiz", "pike", "pikez"])
    expect(nextHandle({ order: ["koi"], given, open: [] })).toBe("koix")
    expect(nextHandle({ order: ["pike"], given, open: [] })).toBe("pikex")
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
