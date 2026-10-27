import { handle } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { bareHandle, handleWords, mention, nextHandle, wordOf } from "./handles.js"

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

describe("the next handle", () => {
  const none = new Set<string>()

  it("is the best word a session has never given", () => {
    expect(nextHandle({ given: none, open: [] }, none)).toBe("moth")
    expect(nextHandle({ given: new Set(["moth"]), open: [] }, none)).toBe("fox")
  })

  it("never gives a closed terminal's word again", () => {
    expect(nextHandle({ given: new Set(["moth", "fox"]), open: [] }, none)).toBe("owl")
  })

  it("prefers a first letter no open terminal starts with", () => {
    // mink is open, so moth, the best word left, gives way to owl; fox, closed, never returns.
    expect(nextHandle({ given: new Set(["fox", "mink"]), open: ["mink"] }, none)).toBe("owl")
  })

  it("prefers a word no other session has open", () => {
    expect(nextHandle({ given: none, open: [] }, new Set(["moth"]))).toBe("fox")
  })

  it("still gives a word when every letter is taken", () => {
    const open = [..."abcdefghijklmnopqrstuvwxyz"].map((letter) => `${letter}zz`)
    expect(nextHandle({ given: none, open }, none)).toBe("moth")
  })

  it("comes round again with a number once every word is given", () => {
    const given = new Set(handleWords)
    expect(nextHandle({ given, open: [] }, none)).toBe("moth2")
    expect(nextHandle({ given: new Set([...given, "moth2"]), open: [] }, none)).toBe("fox2")
  })
})

describe("a handle as written", () => {
  it("is the same handle with or without its @", () => {
    expect(bareHandle("@moth")).toBe("moth")
    expect(bareHandle(" moth ")).toBe("moth")
    expect(bareHandle("@Moth")).toBe("moth")
    // Only the handle: nothing after it is dropped quietly, so a title or a second handle is refused.
    expect(bareHandle("@moth · api-server")).toBe("moth · api-server")
    expect(bareHandle("moth2")).toBe("moth2")
    expect(mention("moth")).toBe("@moth")
  })

  it("keeps its word apart from the round's number", () => {
    expect(wordOf("moth2")).toBe("moth")
    expect(wordOf("moth")).toBe("moth")
  })
})
