import { createScreen, readScreen, type ScreenText } from "@novadeck/emulator/headless"
import {
  box as agy,
  shellCommandOf as agyShellCommand,
  shellFooter as agyFooter,
} from "@novadeck/harness-agy/box"
import { box as claude, shellFooter as claudeFooter } from "@novadeck/harness-claude/box"
import { box as codex, shellFooter as codexFooter } from "@novadeck/harness-codex/box"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { screen as screenWith } from "@novadeck/harness-core/testing/screens"
import {
  checkPaste,
  compact,
  isEmpty,
  sameText,
  showsTail,
  wrappedRows,
  type BoxProfile,
} from "@novadeck/tui-input/box"

import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"

// Each harness's input box, read off the screens real runs drew (fixtures/input-box.probe.json,
// from e2e/probes/input-box.e2e.ts): the pinned version and the latest of 2026-10-07, and
// Codex 0.163.0 of 2026-10-18.
type Fixture = {
  readonly versions: { readonly [version: string]: { readonly [name: string]: ScreenText } }
}

const fixture = (harness: string): Fixture =>
  loadProbe<Fixture>(adapterFolder(harness), "input-box.probe.json")

const hold = (...lines: string[]) => lines.join("\n")
const three = hold("one", "two", "three")
const wrapped = Array.from({ length: 30 }, () => "wrapping words").join(" ")
const ten = hold(...Array.from({ length: 10 }, (_, index) => `Short line ${index + 1}`))
const twentyFive = hold(...Array.from({ length: 25 }, (_, index) => `Short line ${index + 1}`))
const indented = "def check():\n\tif x:   \n        return 1  # trailing   \n\n\nend"
const emoji =
  "Thanks \u2764\ufe0f heart \u{1f468}\u200d\u{1f469}\u200d\u{1f467} family \u65e5\u672c\u8a9e"
const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i % 10}`).join(" ")

/**
 * What a state's box holds: nothing, exactly some text, a collapsed paste, or (`tail`) only
 * the end of a text, the box as tall as its viewport.
 */
type Expect = "empty" | "collapsed" | { readonly text: string } | { readonly tail: string }

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
    // From 0.163.0 a text taller than its box shows only its tail; no current probe records
    // its queued lists.
    name: "Codex",
    profile: codex,
    versions: ["0.163.0"],
    states: {
      ...alike,
      "text indented": { text: indented },
      "size 10 lines": { text: ten },
      "size 25 lines": { tail: twentyFive },
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
        if ("tail" in expected) {
          expect(sameText(read!.text, expected.tail)).toBe(false)
          expect(showsTail(profile, read!, shown[state]!.rows.length, expected.tail)).toBe(true)
        } else expect(sameText(read!.text, expected.text)).toBe(true)
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

describe("Codex 0.163.0's box for a text taller than it", () => {
  const shown = fixture("codex").versions["0.163.0"]!
  const tall = Array.from({ length: 40 }, (_, index) => `Tall line ${index + 1}`).join("\n")

  it.each([24, 30, 40, 50])(
    "is its viewport's height on a screen of %i rows, and shows the tail",
    (rows) => {
      const screen = shown[`tall 40 lines at ${rows} rows`]!
      expect(screen.rows.length).toBe(rows)
      const read = codex.read(screen)!
      expect(read.last - read.first + 1).toBe(codex.viewport!(rows))
      // Its first row's `↑`, drawn dim, is not taken for text.
      expect(read.text.split("\n")[0]!.trim()).toMatch(/^Tall line \d+$/)
      expect(showsTail(codex, read, rows, tall)).toBe(true)
      expect(sameText(read.text, tall)).toBe(false)
    },
  )

  it("never shows the tail of a text that ends otherwise", () => {
    const read = codex.read(shown["tall 40 lines at 40 rows"]!)!
    expect(showsTail(codex, read, 40, `${tall}\nOne more line`)).toBe(false)
  })

  // The head is off the screen, so a text that ends alike but starts otherwise reads as
  // shown too: the paste check relies on the box being empty before the paste.
  it("can't tell a text by its head, which the box doesn't show", () => {
    const read = codex.read(shown["tall 40 lines at 40 rows"]!)!
    expect(showsTail(codex, read, 40, tall.replace("Tall line 1\n", "Another head\n"))).toBe(true)
  })
})

/** A screen as the terminal emulator draws what the TUI writes. */
const drawn = async (output: string, rows = 12): Promise<ScreenText> => {
  const screen = createScreen({ cols: 60, rows, scrollback: 1000 })
  await new Promise<void>((resolve) => screen.write(output, resolve))
  const text = readScreen(screen)
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
    // Its footer says one more Escape clears: a second would open the rewind picker.
    expect(claude.clear?.(box, screenWith({ rows: ["❯ a", "Esc again to clear"] }))).toBe("\x1b")
    expect(claude.clear?.(box, screenWith({ rows: ["❯ a", "? for shortcuts"] }))).toBe("\x1b\x1b")
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
    adapterFolder(harness),
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

describe("the command Antigravity's shell mode is given", () => {
  it("is as written outside Windows", () => {
    expect(agyShellCommand("echo a\necho b", "linux")).toBe("echo a\necho b")
  })

  it("has its lines joined with & on Windows, where cmd runs only the first", () => {
    expect(agyShellCommand("echo a > a.txt\n  echo b\n\necho c", "win32")).toBe(
      "echo a > a.txt & echo b & echo c",
    )
    expect(agyShellCommand("dir", "win32")).toBe("dir")
  })

  it("is none on Windows for lines that joined would mean something else", () => {
    for (const command of [
      "echo a\nrem then b\necho b",
      "echo a\n:: then b\necho b",
      "echo a ^\n  continued",
      "if exist a (\necho yes\n)",
      "echo a\n) else (",
      "echo a\n@rem then b\necho b",
      "echo a\nrem.then b\necho b",
      "echo a\nREM/then b\necho b",
      "echo a\n:label\necho b",
      "echo a &\necho b",
      "echo a &&\necho b",
      "echo a |\nfind a",
      "echo a\n|| echo b",
      "echo a & rem then b\necho b",
      "echo a\n;rem then b\necho b",
      "echo a\n, rem then b\necho b",
      "echo a\n@ rem then b\necho b",
      "echo a\n;:label\necho b",
      "set N=foo\necho %N%",
      "cd sub\necho %CD%",
      "echo a & :: then b\necho b",
      "echo a & :label\necho b",
      "if exist x rem n\necho b",
      "for %%f in (*) do rem x\necho b",
      "if exist x (echo y) else rem n\necho b",
      'echo "a\necho b',
      "if exist x ;rem n\necho b",
      "if exist x ,rem n\necho b",
      "if exist x @rem n\necho b",
      // `^"` opens nothing, so the `"` after it does.
      'echo ^"a" b\necho c',
    ])
      expect(agyShellCommand(command, "win32"), command).toBeUndefined()
    // Quotes in pairs join as written, and a quote cmd only prints is none.
    expect(agyShellCommand('echo "a b"\necho c', "win32")).toBe('echo "a b" & echo c')
    expect(agyShellCommand('echo ^"a\necho c', "win32")).toBe('echo ^"a & echo c')
    // A remark alone, or one word that only starts like one, runs as written.
    expect(agyShellCommand("rem nothing", "win32")).toBe("rem nothing")
    expect(agyShellCommand("echo a\nremove-it.cmd", "win32")).toBe("echo a & remove-it.cmd")
  })
})

describe("Antigravity's word that an Escape stopped the turn", () => {
  const rule = "─".repeat(60)
  // The history above the box, the cursor in it, as the screen the CI run failed on had it.
  const shown = (history: string[]) => {
    const rows = ["> Hold on", "", ...history, rule, "> ", rule, "? for shortcuts"]
    return agy.interrupted!(screen(rows, rows.indexOf("> "), 2))
  }

  it("is read under a reply it kept as well, and alone", () => {
    const word = "  ⎿  Interrupted · What should Antigravity CLI do instead?"
    expect(shown(["  Too late.", "", word])).toBe(true)
    expect(shown([word, ""])).toBe(true)
  })

  it("is not read where the reply is last, nor where it stands above a later turn", () => {
    expect(shown(["  Too late.", ""])).toBe(false)
    expect(
      shown(["  ⎿  Interrupted · What should Antigravity CLI do instead?", "> Next", "  Done."]),
    ).toBe(false)
  })

  it("is read wrapped over rows, as on a tile narrower than its line", () => {
    expect(
      shown(["  Too late.", "", "  ⎿  Interrupted · What should Ant", "igravity CLI do instead?"]),
    ).toBe(true)
    expect(shown(["  ⎿  Interrupted · What", " should Antigravity CLI ", "do instead?"])).toBe(true)
  })

  it("can't tell where no box is found to read above, as mid-redraw or under a dialog", () => {
    const word = "  ⎿  Interrupted · What should Antigravity CLI do instead?"
    expect(agy.interrupted!(screen(["  Too late.", word, "Run this command?"], 2))).toBeUndefined()
  })
})

describe("the viewport of Claude Code's input box", () => {
  it("is what was probed on the screens it was, and never below one row on a small one", () => {
    expect([24, 40, 60].map((rows) => claude.viewport!(rows))).toEqual([7, 15, 25])
    for (const rows of [0, 4, 10, 11, 12]) expect(claude.viewport!(rows)).toBeGreaterThanOrEqual(1)
  })
})

// Views of a harness that show an empty-looking box or field, probed 2026-10-16 in the e2e
// sandbox (Claude Code 2.1.287, Codex 0.159.3, Antigravity 1.2.14): no ring may go there.
describe("a view drawn beside an empty box", () => {
  const rule = "─".repeat(60)
  const shown = (...rows: string[]) => screenWith({ rows })

  it("is Claude Code's agents view, prompt history search and transcript, never its prompt", () => {
    const prompt = shown("● Warmed up.", rule, "❯ ", rule, "  ⏸ manual mode on · ← for agents")
    expect(claude.overlay(prompt)).toBe(false)
    const agents = screenWith({
      rows: [
        "Your conversation moved to the background — enter opens it · esc returns to it",
        rule,
        "❯ describe a task for a new session",
        rule,
        "  enter to return · space to reply · ctrl+x to delete · ? for shortcuts",
      ],
      cursor: { row: 2, column: 2 },
    })
    // Its field reads as an empty prompt box, which is why the screen is checked for the view.
    expect(claude.read(agents)).toMatchObject({ mode: "prompt" })
    expect(claude.overlay(agents)).toBe(true)
    expect(
      claude.overlay(
        shown(
          "  Search prompts · everywhere",
          "  ↑/↓ to navigate · Enter to use · Esc to cancel · ctrl+s to scope",
        ),
      ),
    ).toBe(true)
    expect(
      claude.overlay(shown("  Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll")),
    ).toBe(true)
  })

  it("is Codex's history search and shortcuts panel, never its prompt", () => {
    const prompt = shown(
      "• Warmed up.",
      "› Ask Codex to do anything",
      "  fake-model default · /tmp/p",
      "  ? for shortcuts",
    )
    expect(codex.overlay(prompt)).toBe(false)
    expect(
      codex.overlay(
        shown("› Ask Codex to do anything", "  fake-model default", "  reverse-i-search:"),
      ),
    ).toBe(true)
    expect(
      codex.overlay(shown("› Ask Codex to do anything", "  fake-model default", "  ? / esc close")),
    ).toBe(true)
    // A /side conversation's box is no root's, whichever way the keys are spelled.
    for (const keys of ["ctrl+", "^", "⌃"])
      expect(
        codex.overlay(
          shown(
            "› Ask Codex to do anything",
            `  Side from main thread · ${keys}/ to switch · ${keys}c to close`,
          ),
        ),
      ).toBe(true)
  })

  it("is Antigravity's shortcuts and artifacts panels, never its prompt", () => {
    expect(agy.overlay(shown(rule, ">", rule, "? for shortcuts      Gemini 3.1 Pro · low"))).toBe(
      false,
    )
    expect(
      agy.overlay(
        shown(
          rule,
          ">",
          rule,
          "Artifacts",
          "  No artifacts",
          "Keyboard: ↑/↓ Navigate  p preview  enter open  ctrl+g open in editor  esc Dismiss",
        ),
      ),
    ).toBe(true)
    expect(
      agy.overlay(
        shown(
          rule,
          ">",
          rule,
          "Keyboard Shortcuts",
          "Keyboard: ↑/↓ Navigate  ←/→ Switch View  esc Close",
        ),
      ),
    ).toBe(true)
  })
})

describe("a view is told by the rows under the box, never by the conversation above", () => {
  const rule = "─".repeat(60)
  const shown = (...rows: string[]) => screenWith({ rows })

  it("ignores a transcript that quotes a view's footer", () => {
    const prompt = [rule, "❯ ", rule, "  ⏸ manual mode on · ← for agents"]
    expect(
      claude.overlay(shown("● the footer says: enter to return · space to reply", "", ...prompt)),
    ).toBe(false)
    expect(
      codex.overlay(
        shown(
          "• it printed reverse-i-search: and ? / esc close",
          ...Array(6).fill("• done"),
          "› ",
          "  ? for shortcuts",
        ),
      ),
    ).toBe(false)
    expect(
      agy.overlay(
        shown(
          "Keyboard: ↑/↓ Navigate  esc Close",
          ...Array(6).fill("done"),
          rule,
          ">",
          rule,
          "? for shortcuts",
        ),
      ),
    ).toBe(false)
  })
})

describe("a view's hint under a box with a long status line", () => {
  const rule = "─".repeat(60)
  it("is still found, as the rows from the box down are read, not the last four", () => {
    const view = screenWith({
      rows: [
        "● Warmed up.",
        rule,
        "❯ describe a task for a new session",
        rule,
        "  enter to return · space to reply · ctrl+x to delete",
        "  status one",
        "  status two",
        "  status three",
        "  status four",
        "  status five",
      ],
      cursor: { row: 2, column: 2 },
    })
    expect(claude.overlay(view)).toBe(true)
  })
})

// Each harness's box while only work its stopped turn left running runs, read off the
// screens real runs drew (fixtures/background-prompt.probe.json, from
// e2e/probes/background-prompt.e2e.ts, 2026-10-19): Claude Code with a background agent and
// shell, its footer counting them and a spinner's row above the box; Antigravity with a
// subagent, its panel drawn between rules under the box; Codex with a spawned agent, the
// root idle. Each took a typed prompt then, so its box reads as any other.
describe.each([
  { name: "Claude Code", harness: "claude", profile: claude },
  { name: "Codex", harness: "codex", profile: codex },
  { name: "Antigravity", harness: "agy", profile: agy },
])("the input box of $name while its background work runs", ({ harness, profile }) => {
  const { screens } = loadProbe<{ screens: { readonly [name: string]: ScreenText } }>(
    adapterFolder(harness),
    "background-prompt.probe.json",
  )

  it("reads empty, at its prompt, with no view over it and nothing queued", () => {
    for (const label of ["1 stopped, work running", "3 after the prompt"]) {
      const shown = screens[label]!
      expect(profile.read(shown)).toMatchObject({ mode: "prompt" })
      expect(isEmpty(profile.read(shown)!)).toBe(true)
      expect(profile.overlay(shown)).toBe(false)
      expect(profile.queued(shown)).toBe(false)
    }
  })

  it("reads the key typed in it", () => {
    expect(profile.read(screens["2 a key typed"]!)).toMatchObject({ mode: "prompt", text: "P" })
  })
})

describe("Antigravity's panel of running subagents under its box", () => {
  const rule120 = "─".repeat(120)
  const panel = (cursor: number, ...inside: string[]) =>
    screenWith({
      rows: ["> Start the work", "", rule120, "> ", rule120, ...inside, rule120, "? for shortcuts"],
      cursor: { row: cursor, column: 2 },
    })

  it("is set aside, one row or several", () => {
    expect(agy.read(panel(3, "  ● Agent(self: One)  Working · 1s"))).toMatchObject({ text: "" })
    expect(
      agy.read(
        panel(3, "  ● Agent(self: One)  Working · 1s", "  ● Agent(self: Two)  Working · 2s"),
      ),
    ).toMatchObject({ text: "" })
  })

  it("is no panel when it holds anything else, or the cursor is not above it", () => {
    expect(agy.read(panel(3, "  Something else"))).toBeUndefined()
    expect(agy.read(panel(5, "  ● Agent(self: One)  Working · 1s"))).toBeUndefined()
  })
})

// What each harness redraws by itself while background work runs, which the doorbell's calm
// and its paste's check read without (`BoxProfile.still`): Claude Code counts up a background
// agent's elapsed time in its agents list each second; Antigravity redraws its panel of
// running subagents, elapsed time and all, as a paste lands, pushing its footer's hint out of
// a paste's reach.
describe("what ticks by itself while background work runs", () => {
  it("is Claude Code's background agent's elapsed time, every row it drew read alike", () => {
    const { changing } = loadProbe<{ changing: { readonly [row: string]: string[] } }>(
      adapterFolder("claude"),
      "background-prompt.probe.json",
    )
    const shown = Object.values(changing).flat()
    expect(shown.length).toBeGreaterThan(1)
    expect(new Set(shown.map((row) => claude.still!([row])[0])).size).toBe(1)
    // #325's, with hours and tokens; its main row, and a running turn's spinner, kept.
    expect(
      claude.still!([
        "  ◯ fixer   Checking test results in test12.log      3h 40m 8s · ↓ 708.9k tokens",
        "  ● main",
        "✻ Thinking… (3s · esc to interrupt)",
      ]),
    ).toEqual([
      "  ◯ fixer   Checking test results in test12.log",
      "  ● main",
      "✻ Thinking… (3s · esc to interrupt)",
    ])
  })

  it("is Antigravity's panel, set aside, so a paste's check accepts the line it lands", () => {
    const { screens } = loadProbe<{ screens: { readonly [name: string]: ScreenText } }>(
      adapterFolder("agy"),
      "background-prompt.probe.json",
    )
    const before = screens["1 stopped, work running"]!.rows
    const line = "[Novadeck: automatic notice, agent messages waiting, ABCDEF]"
    // The box takes the line, the panel redraws its time, the footer's hint goes.
    const after = before.map((row, at) =>
      at === 18
        ? `> ${line}`
        : at === 20
          ? row.replace(/\d+s$/, "9s")
          : at === 22
            ? row.replace("? for shortcuts", "               ")
            : row,
    )
    expect(checkPaste(before, after, line)).toMatchObject({ accepted: false })
    expect(checkPaste(agy.still!(before), agy.still!(after), line)).toMatchObject({
      accepted: true,
    })
    // No panel, nothing set aside.
    const plain = fixture("agy").versions
    const empty = Object.values(plain)[0]!["1 ready empty"]!.rows
    expect(agy.still!(empty)).toEqual(empty)
  })
})
