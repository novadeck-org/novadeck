import { join } from "node:path"

import headless from "@xterm/headless"

import { screenText, type ScreenText } from "../terminals/screen.js"
import { describe, expect, it } from "../test.js"
import { loadProbe } from "../testing/probes.js"
import { screen as screenWith } from "../testing/screens.js"
import { box as agy, shellFooter as agyFooter } from "./agy/box.js"
import { compact, isEmpty, sameText, wrappedRows, type BoxProfile } from "./box.js"
import { box as claude, shellFooter as claudeFooter } from "./claude/box.js"
import { box as codex, shellFooter as codexFooter } from "./codex/box.js"

// Each harness's input box, read off the screens real runs drew (fixtures/input-box.probe.json,
// from e2e/probes/input-box.e2e.ts): the pinned version and the latest of 2026-10-07.
type Fixture = {
  readonly versions: { readonly [version: string]: { readonly [name: string]: ScreenText } }
}

const fixture = (harness: string): Fixture =>
  loadProbe<Fixture>(join(import.meta.dirname, harness), "input-box.probe.json")

const hold = (...lines: string[]) => lines.join("\n")
const three = hold("one", "two", "three")
const wrapped = Array.from({ length: 30 }, () => "wrapping words").join(" ")
const ten = hold(...Array.from({ length: 10 }, (_, index) => `Short line ${index + 1}`))
const twentyFive = hold(...Array.from({ length: 25 }, (_, index) => `Short line ${index + 1}`))
const indented = "def check():\n\tif x:   \n        return 1  # trailing   \n\n\nend"
const emoji =
  "Thanks \u2764\ufe0f heart \u{1f468}\u200d\u{1f469}\u200d\u{1f467} family \u65e5\u672c\u8a9e"
const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i % 10}`).join(" ")

/** What a state's box holds: nothing, exactly some text, or a collapsed paste. */
type Expect = "empty" | "collapsed" | { readonly text: string }

// The states every harness shows alike.
const alike: { readonly [name: string]: Expect } = {
  "1 ready empty": "empty",
  "2 ready first key": { text: "D" },
  "4 draft pasted": { text: "Draft of the person" },
  "5 draft typed": { text: "Typed draft" },
  "6 short pasted": { text: "go" },
  "7 three lines": { text: three },
  "8 wrapped line": { text: wrapped },
  "9 long collapsed": "collapsed",
  "12 after turn": "empty",
  "13 draft after turn": { text: "Draft after turn" },
  "14 mid-turn empty": "empty",
  "15 mid-turn short pasted": { text: "go" },
  "16 mid-turn three lines": { text: three },
  "17 mid-turn long collapsed": "collapsed",
  "text emoji": { text: emoji },
  "size 700 chars": { text: words(240) },
  "size 1500 chars": "collapsed",
}

// Where a harness collapses a paste, which differs: Claude Code from more than three lines,
// Antigravity from more than fifteen, Codex from about a thousand characters (box.ts has
// the probed thresholds).
const harnesses: readonly {
  readonly name: string
  readonly profile: BoxProfile
  readonly versions: readonly string[]
  readonly states: { readonly [name: string]: Expect }
}[] = [
  {
    name: "Claude Code",
    profile: claude,
    versions: ["2.1.287", "2.1.292"],
    states: {
      ...alike,
      "text indented": "collapsed",
      queued: "empty",
      "queued pulled back": { text: "Queued beta" },
      "size 10 lines": "collapsed",
      "size 25 lines": "collapsed",
    },
  },
  {
    name: "Codex",
    profile: codex,
    versions: ["0.159.3", "0.160.1"],
    states: {
      ...alike,
      "text indented": { text: indented },
      queued: "empty",
      "queued steered": "empty",
      "size 10 lines": { text: ten },
      "size 25 lines": { text: twentyFive },
    },
  },
  {
    name: "Antigravity",
    profile: agy,
    versions: ["1.2.14", "1.3.1"],
    states: {
      ...alike,
      "text indented": { text: indented },
      queued: "empty",
      "queued pulled back": { text: "Queued beta" },
      "two queued pulled back": { text: "Queued beta\nQueued gamma" },
      "size 10 lines": { text: ten },
      "size 25 lines": "collapsed",
    },
  },
]

describe.each(harnesses)("the input box of $name", ({ name, profile, versions, states }) => {
  const key = name === "Claude Code" ? "claude" : name === "Codex" ? "codex" : "agy"
  const { versions: seen } = fixture(key)

  describe.each(versions)("as %s draws it", (version) => {
    const shown = seen[version]!

    it("is probed in every state the harness is checked in", () => {
      expect(Object.keys(shown)).toEqual(expect.arrayContaining(Object.keys(states)))
    })

    it.each(Object.entries(states))("reads %s", (state, expected) => {
      const read = profile.read(shown[state]!)
      expect(read, "its box is found").toBeDefined()
      if (expected === "empty") expect(isEmpty(read!), `holds ${JSON.stringify(read)}`).toBe(true)
      else if (expected === "collapsed") expect(profile.collapsed(read!)).toBe(true)
      else {
        expect(isEmpty(read!)).toBe(false)
        expect(profile.collapsed(read!)).toBe(false)
        expect(sameText(read!.text, expected.text)).toBe(true)
      }
    })

    it("tells queued messages on the screen in the state that has them and no other", () => {
      for (const [state, screen] of Object.entries(shown))
        expect(profile.queued(screen), state).toBe(state === "queued")
    })

    it("does not take a collapsed placeholder with more text for the placeholder alone", () => {
      const read = profile.read(shown["10 collapsed then more"]!)
      expect(read).toBeDefined()
      expect(isEmpty(read!)).toBe(false)
      expect(profile.collapsed(read!)).toBe(false)
      expect(compact(read!.text)).toContain("andmore")
    })

    it("places the box where the cursor is, whatever is above it", () => {
      for (const [state, screen] of Object.entries(shown)) {
        const read = profile.read(screen)
        if (!read) continue
        expect(screen.cursor.row, state).toBeGreaterThanOrEqual(read.first)
        expect(screen.cursor.row, state).toBeLessThanOrEqual(read.last)
      }
    })

    it("finds no box on a screen that shows none", () => {
      expect(profile.read(screenWith({ rows: Array<string>(40).fill("") }))).toBe(undefined)
      const text = shown["12 after turn"]!
      const noCursor = { ...text, cursor: { row: 2, column: 4 } }
      expect(profile.read(noCursor)).toBe(undefined)
    })
  })
})

/** A screen as the terminal emulator draws what the TUI writes. */
const drawn = async (output: string, rows = 12): Promise<ScreenText> => {
  const screen = new headless.Terminal({ cols: 60, rows, allowProposedApi: true })
  await new Promise<void>((resolve) => screen.write(output, resolve))
  const text = screenText(screen)
  screen.dispose()
  return text
}
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`

describe("a box whose placeholder is drawn dim", () => {
  const rule = "─".repeat(60)

  it("is empty in Codex though its row shows the suggestion", async () => {
    const screen = await drawn(`\x1b[11;1H› ${dim("Ask Codex to do anything")}\x1b[11;3H`)
    expect(screen.rows[10]).toContain("Ask Codex to do anything")
    expect(isEmpty(codex.read(screen)!)).toBe(true)
  })

  it("is empty in Claude Code though its row shows a suggestion", async () => {
    const screen = await drawn(
      `\x1b[8;1H${rule}\x1b[9;1H❯ ${dim('Try "fix lint errors"')}\x1b[10;1H${rule}\x1b[9;3H`,
    )
    expect(screen.rows[8]).toContain("fix lint errors")
    expect(isEmpty(claude.read(screen)!)).toBe(true)
  })

  it("is empty in Antigravity though its row shows a suggestion", async () => {
    const screen = await drawn(
      `\x1b[8;1H${rule}\x1b[9;1H> ${dim("Ask anything")}\x1b[10;1H${rule}\x1b[9;3H`,
    )
    expect(isEmpty(agy.read(screen)!)).toBe(true)
  })

  it("still holds a draft the person typed in the same words, as the cursor is past them", async () => {
    // Not drawn dim, so it is text; and drawn dim with the cursor past it, it is text still.
    const typed = await drawn(`\x1b[11;1H› Ask Codex to do anything\x1b[11;27H`)
    expect(compact(codex.read(typed)!.text)).toBe("AskCodextodoanything")
    const faint = await drawn(`\x1b[11;1H› ${dim("Ask Codex")}\x1b[11;12H`)
    expect(isEmpty(codex.read(faint)!)).toBe(false)
  })
})

const screen = (rows: string[], row: number, column = 0): ScreenText =>
  screenWith({ rows, cursor: { row, column } })
const lines = (count: number) => Array.from({ length: count }, () => "l").join("\n")

describe("boxes read from synthetic screens", () => {
  const rule = "─".repeat(40)

  it("reads Codex lines indented more than the body, with blank lines inside", () => {
    const read = codex.read(screen(["› def check():", "    return 1", "", "", "  end"], 4, 5))
    expect(read?.text).toBe("def check():\n  return 1\n\n\nend")
    expect(read?.first).toBe(0)
  })

  it("stops Codex's box at the nearest marker row, not the history above", () => {
    const read = codex.read(screen(["› Say hello", "", "  Hello there.", "", "› go"], 4, 4))
    expect(read).toMatchObject({ first: 4, last: 4, text: "go" })
  })

  it("reads Claude's box from its marker row, not from stale rows between the rules", () => {
    const rows = [rule, "❯ Thanks ❤️ heart", "✢ Churning…", "❯", rule]
    const read = claude.read(screen(rows, 3, 2))
    expect(read).toMatchObject({ first: 3, last: 3 })
    expect(isEmpty(read!)).toBe(true)
  })

  it("finds no Claude box where no row between the rules holds its marker", () => {
    expect(claude.read(screen([rule, "  stale", rule], 1))).toBe(undefined)
  })

  it("compares text without the emoji a TUI left blank, but not emoji alone", () => {
    expect(sameText("Hi  there", "Hi 👨‍👩‍👧 there")).toBe(true)
    expect(sameText("", "👍")).toBe(false)
    expect(sameText("👍", "👍")).toBe(true)
    expect(sameText("Hi there too", "Hi there")).toBe(false)
  })

  it("tells how tall a text is, and which harness collapses it", () => {
    expect(wrappedRows("a\n\nb", 80)).toBe(3)
    expect(wrappedRows("x".repeat(100), 42)).toBe(3)
    expect(wrappedRows("日".repeat(30), 32)).toBe(2)
    // Words wrap whole, as Codex drew 18 rows at 80 columns for these six lines.
    const seven = Array.from({ length: 7 }, () => "w".repeat(20)).join(" ")
    expect(wrappedRows(Array.from({ length: 6 }, () => seven).join("\n"), 80)).toBe(18)
    expect(wrappedRows("a\tb", 80)).toBe(1)
    expect(wrappedRows(`${"x".repeat(5)}\t${"y".repeat(10)}`, 12)).toBe(2)
    expect(wrappedRows("x".repeat(25), 12)).toBe(3)
    // Typographic punctuation takes one column, as the emulator draws it; a ZWJ family two.
    expect(wrappedRows("\u2019".repeat(40), 42)).toBe(1)
    expect(wrappedRows("\u2014 ".repeat(20).trimEnd(), 42)).toBe(1)
    expect(wrappedRows("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}".repeat(20), 42)).toBe(1)
    expect(wrappedRows("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}".repeat(21), 42)).toBe(2)
    expect(claude.collapses(lines(4))).toBe(true)
    expect(claude.collapses(lines(3))).toBe(false)
    expect(codex.collapses(lines(30))).toBe(false)
    expect(codex.collapses("x".repeat(1100))).toBe(true)
    expect(agy.collapses(lines(16))).toBe(true)
    expect(agy.collapses(lines(15))).toBe(false)
    expect(codex.room(20)).toBe(17)
  })

  it("clears text put back in the box only where a harness puts some back", () => {
    const box = { text: "a\nb", mode: "prompt" as const, first: 3, last: 4 }
    expect(claude.clear?.(box)).toBe("\x1b\x1b")
    expect(agy.clear?.(box)).toBe("\x15\x7f\x15")
    expect(agy.clear?.({ text: "a", mode: "prompt" as const, first: 3, last: 3 })).toBe("\x15")
    expect(codex.clear).toBe(undefined)
  })

  it("takes the cursor's cell over a placeholder's first letter for no draft", () => {
    // Claude Code draws it undimmed: "Press up to edit queued messages" reads as "P".
    const rows = [rule, "❯\u00a0Press up to edit queued messages", rule]
    const lit = [rule, "❯\u00a0P", rule]
    const faint = screenWith({ rows, bright: lit, cursor: { row: 1, column: 2 } })
    expect(isEmpty(claude.read(faint)!)).toBe(true)
    // A draft of one letter has nothing faint after it.
    const one = screenWith({
      rows: [rule, "❯\u00a0P", rule],
      bright: [rule, "❯\u00a0P", rule],
      cursor: { row: 1, column: 2 },
    })
    expect(isEmpty(claude.read(one)!)).toBe(false)
    // With the cursor past it, it is a draft.
    const typed = screenWith({ rows, bright: lit, cursor: { row: 1, column: 3 } })
    expect(isEmpty(claude.read(typed)!)).toBe(false)
  })
})

// Each harness's shell mode (`!`), as the screens of a real run showed it
// (fixtures/shell-mode.probe.json, from e2e/probes/shell-bang.e2e.ts): the box's marker
// says it, the footer agrees, and a box whose footer disagrees reads as no box.
type ShellCase = { step: string; version: string; shell: boolean; rows: string[] }
const shellCases = (harness: string): ShellCase[] =>
  loadProbe<{ cases: (Omit<ShellCase, "rows"> & { screen: ScreenText })[] }>(
    join(import.meta.dirname, harness),
    "shell-mode.probe.json",
  ).cases.map(({ screen: shown, ...rest }) => ({ ...rest, rows: [...shown.rows] }))

/** A screen of the rows with its cursor on the box's first row, as the harness draws it. */
const cursored = (rows: string[], framed: boolean): ScreenText => {
  const rules = rows.flatMap((row, index) => (/^─{8,}$/.test(row.trim()) ? [index] : []))
  const first = framed
    ? rules.at(-2)! + 1
    : rows.findLastIndex((row) => row.startsWith("›") || row.startsWith("!"))
  return screenWith({ rows, cursor: { row: first, column: 2 } })
}

const mixed = (box: string[], foot: string[]) => [
  ...box.slice(0, -1),
  foot.findLast((row) => row.trim() !== "")!,
]

describe.each([
  { name: "Claude Code", footer: claudeFooter, profile: claude, key: "claude", framed: true },
  { name: "Codex", footer: codexFooter, profile: codex, key: "codex", framed: false },
  { name: "Antigravity", footer: agyFooter, profile: agy, key: "agy", framed: true },
])("the shell mode of $name", ({ footer, profile, key, framed }) => {
  const cases = shellCases(key)

  it.each(cases.map((each) => [`${each.version} ${each.step}`, each] as const))(
    "reads %s",
    (_name, { shell, rows }) => {
      expect(footer(rows)).toBe(shell)
      const box = profile.read(cursored(rows, framed))
      expect(box, "its box is found").toBeDefined()
      expect(box!.mode).toBe(shell ? "shell" : "prompt")
    },
  )

  it("reads nothing of a screen with nothing on it", () => {
    expect(footer([])).toBe(false)
    expect(footer(["", "  "])).toBe(false)
  })

  it("finds no box where the footer says the shell mode over a prompt's marker", () => {
    const prompt = cases.find((each) => !each.shell && each.step === "9-idle")
    const shell = cases.find((each) => each.shell && each.step === "9-bang")
    expect(profile.read(cursored(mixed(prompt!.rows, shell!.rows), framed))).toBe(undefined)
  })

  it("still reads a shell mode's box under another hint than its footer", () => {
    // Claude Code's "paste again to expand", under a pasted command's placeholder.
    const prompt = cases.find((each) => !each.shell && each.step === "9-idle")
    const shell = cases.find((each) => each.shell && each.step === "9-bang")
    const box = profile.read(cursored(mixed(shell!.rows, prompt!.rows), framed))
    expect(box?.mode).toBe("shell")
  })

  it("says whether a command shown as a placeholder runs as the text it stands for", () => {
    expect(profile.shell.expands).toBe(key !== "agy")
  })
})

describe("the viewport of Claude Code's input box", () => {
  it("is what was probed on the screens it was, and never below one row on a small one", () => {
    expect([24, 40, 60].map((rows) => claude.viewport!(rows))).toEqual([7, 15, 25])
    for (const rows of [0, 4, 10, 11, 12]) expect(claude.viewport!(rows)).toBeGreaterThanOrEqual(1)
  })
})
