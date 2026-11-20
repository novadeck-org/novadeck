import { describe, expect, it } from "vitest"

import { agentAsk } from "./inbox.js"
import { hasControlCharacters } from "./prompts.js"
import { startupCommand, terminalTitle, titleFrom } from "./terminals.js"
import { asLine, bytesText, hiddenAt, hiddenIn, unsafeCharacter, unsafeInLine } from "./text.js"

// What the one rule for text a person reads refuses, each a way to make a line read as
// something it isn't or to reach a terminal as an escape.
const unsafe = [
  ["a right-to-left override", "\u202e"],
  ["a left-to-right isolate", "\u2066"],
  ["an Arabic letter mark", "\u061c"],
  ["a C1 control sequence introducer", "\u009b"],
  ["DEL", "\u007f"],
  ["an escape", "\u001b"],
  ["a zero-width space", "\u200b"],
  ["a byte-order mark", "\ufeff"],
  ["a line separator", "\u2028"],
] as const

// What it keeps: text people write, emoji joined into one, and scripts that need a joiner.
const kept = [
  ["accented letters", "Café déjà vu"],
  ["a joined emoji", "\u{1f469}\u200d\u{1f4bb} api"],
  ["a Persian word with a non-joiner", "برنامه\u200cنویسی"],
  ["Hebrew", "שלום"],
] as const

describe("the rule for text a person reads", () => {
  it.each(unsafe)("refuses %s", (_name, character) => {
    expect(unsafeCharacter.test(`a${character}b`)).toBe(true)
    expect(unsafeInLine.test(`a${character}b`)).toBe(true)
  })

  it.each(kept)("keeps %s", (_name, text) => {
    expect(unsafeInLine.test(text)).toBe(false)
  })

  it("lets text run over lines and tabs, but not one line", () => {
    expect(unsafeCharacter.test("a\tb\nc")).toBe(false)
    expect(unsafeInLine.test("a\tb")).toBe(true)
    expect(unsafeInLine.test("a\nb")).toBe(true)
  })

  describe("making one line", () => {
    it("turns each run of what a line refuses into one space", () => {
      expect(asLine(" build\u202e\u0007\n\tnow ")).toBe("build now")
    })

    it("leaves a line that holds nothing it refuses as it is", () => {
      expect(asLine("\u{1f469}\u200d\u{1f4bb} api")).toBe("\u{1f469}\u200d\u{1f4bb} api")
    })
  })
})

describe("a terminal title", () => {
  it.each(unsafe)("refuses %s", (_name, character) => {
    expect(terminalTitle.safeParse(`build ${character}evil`).success).toBe(false)
  })

  it.each(kept)("takes %s", (_name, text) => {
    expect(terminalTitle.parse(text)).toBe(text)
  })

  it("counts an emoji once toward its 200 characters", () => {
    expect(terminalTitle.safeParse("\u{1f600}".repeat(200)).success).toBe(true)
    expect(terminalTitle.safeParse("\u{1f600}".repeat(201)).success).toBe(false)
  })

  describe("made from text no title rule checked", () => {
    it("is that text as one line a title takes", () => {
      const title = titleFrom("notes\u202e.txt\u009b\n")!
      expect(title).toBe("notes .txt")
      expect(terminalTitle.parse(title)).toBe(title)
    })

    it("is cut to 200 characters, never inside one", () => {
      const title = titleFrom(`${"a".repeat(199)}\u{1f600}\u{1f600}`)!
      expect([...title]).toHaveLength(200)
      expect(title.endsWith("\u{1f600}")).toBe(true)
    })

    it("is nothing when nothing is left", () => {
      expect(titleFrom("\u202e\u0007 ")).toBeUndefined()
    })
  })
})

describe("a startup command", () => {
  it.each(unsafe)("refuses %s", (_name, character) => {
    expect(startupCommand.safeParse(`echo ${character}hi`).success).toBe(false)
  })

  it("takes a plain line", () => {
    expect(startupCommand.parse("pnpm dev --port 3000")).toBe("pnpm dev --port 3000")
  })
})

describe("an Inbox line", () => {
  const ask = (subject: string) => ({
    subject,
    body: "",
    details: null,
    hardToUndo: null,
    shape: { type: "text" as const },
  })

  it.each(unsafe)("refuses %s", (_name, character) => {
    expect(agentAsk.safeParse(ask(`Deploy ${character}now`)).success).toBe(false)
  })

  it("takes a plain line", () => {
    expect(agentAsk.parse(ask("Deploy now?")).subject).toBe("Deploy now?")
  })
})

describe("a prompt's control characters", () => {
  it("are the controls an input box takes as keys, not the marks a title refuses", () => {
    expect(hasControlCharacters("a\u009bb")).toBe(true)
    expect(hasControlCharacters("a\u007fb")).toBe(true)
    expect(hasControlCharacters("line\r\nline\ttab")).toBe(false)
    expect(hasControlCharacters("ש\u200fל")).toBe(false)
  })
})

describe("a character that draws as nothing", () => {
  it("is found where it is, as U+XXXX", () => {
    expect(hiddenIn("rm\u200b -rf")).toBe("U+200B")
    expect(hiddenIn("ls　-la")).toBe("U+3000")
    expect(hiddenIn("ls -la")).toBeUndefined()
  })

  describe("as an emoji's colour form, U+FE0F", () => {
    it("draws after an emoji", () => {
      expect(hiddenAt("❤️", 1)).toBe(false)
    })

    it("draws after an emoji outside the basic plane, a surrogate pair stepped back over", () => {
      expect(hiddenAt("\u{1f44d}️", 2)).toBe(false)
    })

    it("draws as a keycap after a digit", () => {
      expect(hiddenAt("1️⃣", 1)).toBe(false)
    })

    it("draws as nothing after a letter, or at the start", () => {
      expect(hiddenAt("a️", 1)).toBe(true)
      expect(hiddenAt("️", 0)).toBe(true)
    })
  })
})

describe("a size in bytes", () => {
  const kb = 1024
  const mb = kb * kb
  const gb = mb * kb

  it("reads in bytes, whole kilobytes, and megabytes with a decimal", () => {
    expect([0, 1, 77, 1023, 1024, 2048, 12 * kb, 1.5 * mb, 12.3 * mb].map(bytesText)).toEqual([
      "0 B",
      "1 B",
      "77 B",
      "1023 B",
      "1 KB",
      "2 KB",
      "12 KB",
      "1.5 MB",
      "12.3 MB",
    ])
  })

  it("steps up to the next unit where the rounded figure would read 1024 of the last", () => {
    expect(bytesText(mb - 1)).toBe("1.0 MB")
    expect(bytesText(1_048_100)).toBe("1.0 MB")
    expect(bytesText(1_048_000)).toBe("1023 KB")
    expect(bytesText(1023.4 * kb)).toBe("1023 KB")
    expect(bytesText(gb - 1)).toBe("1.0 GB")
    expect(bytesText(1023.96 * mb)).toBe("1.0 GB")
    expect(bytesText(1023.9 * mb)).toBe("1023.9 MB")
  })

  it("goes on in gigabytes and terabytes", () => {
    expect(bytesText(5 * gb)).toBe("5.0 GB")
    expect(bytesText(1.5 * gb)).toBe("1.5 GB")
    expect(bytesText(3 * kb * gb)).toBe("3.0 TB")
    expect(bytesText(5000 * kb * gb)).toBe("5000.0 TB")
  })
})
