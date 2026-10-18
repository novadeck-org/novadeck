import { describe, expect, it } from "vitest"

import { editLine, emptyLine, restoreLine, withReturnedWords, type Line } from "./line-editor"

// The line after the keys, each chunk as the emulator sends one.
const keys = (chunks: readonly string[], from: Line = emptyLine()) => {
  let line = from
  const events = []
  for (const chunk of chunks) {
    const read = editLine(line, chunk)
    line = read.line
    events.push(...read.events)
  }
  return { line, events }
}

// The draft with a bar where the cursor is.
const shown = ({ draft, cursor }: Line): string =>
  `${draft.slice(0, cursor)}|${draft.slice(cursor)}`

const left = "\x1b[D"
const right = "\x1b[C"
const up = "\x1b[A"
const down = "\x1b[B"

describe("a demo terminal's command line", () => {
  it("inserts what is typed at the cursor", () => {
    expect(shown(keys(["l", "s"]).line)).toBe("ls|")
    expect(shown(keys(["git log", left, left, left, left, "x"]).line)).toBe("gitx| log")
    // A chunk of several keys, as typing fast or an emulator's batch sends.
    expect(shown(keys(["echo hi"]).line)).toBe("echo hi|")
    expect(shown(keys(["héllo 👋"]).line)).toBe("héllo 👋|")
  })

  it("deletes with Backspace before the cursor and with Delete after it", () => {
    expect(shown(keys(["abc", "\x7f"]).line)).toBe("ab|")
    expect(shown(keys(["abc", "\b"]).line)).toBe("ab|")
    expect(shown(keys(["abc", left, left, "\x1b[3~"]).line)).toBe("a|c")
    // Nothing before or after to delete.
    expect(shown(keys(["\x7f"]).line)).toBe("|")
    expect(shown(keys(["ab", "\x1b[3~"]).line)).toBe("ab|")
    // A character goes whole: never half a pair, an accent without its letter, or a skin
    // tone without its emoji.
    expect(keys(["a👋", "\x7f"]).line.draft).toBe("a")
    expect(keys(["👋b", "\x01", "\x1b[3~"]).line.draft).toBe("b")
    expect(keys(["ae\u0301", "\x7f"]).line.draft).toBe("a")
    expect(keys(["a👍🏽", "\x7f"]).line.draft).toBe("a")
  })

  it("moves with ←/→ and Home/End, in each encoding the emulator sends", () => {
    expect(shown(keys(["abc", left, left, right]).line)).toBe("ab|c")
    expect(shown(keys(["abc", "\x1bOD"]).line)).toBe("ab|c")
    for (const home of ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~", "\x01"])
      expect(shown(keys(["abc", home]).line)).toBe("|abc")
    for (const end of ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~", "\x05"])
      expect(shown(keys(["abc", "\x01", end]).line)).toBe("abc|")
    // The ends hold.
    expect(shown(keys(["ab", right]).line)).toBe("ab|")
    expect(shown(keys(["ab", "\x01", left]).line)).toBe("|ab")
    // Past a character in one step, whatever it is made of.
    expect(keys(["a👋", left]).line.cursor).toBe(1)
    expect(keys(["👋b", "\x01", right]).line.cursor).toBe(2)
    expect(keys(["a👍🏽", left]).line.cursor).toBe(1)
  })

  it("moves a word at a time with Ctrl or Alt and ←/→", () => {
    expect(shown(keys(["git log --all", "\x1b[1;5D"]).line)).toBe("git log |--all")
    expect(shown(keys(["git log --all", "\x1b[1;3D", "\x1b[1;3D"]).line)).toBe("git |log --all")
    expect(shown(keys(["git log --all", "\x01", "\x1b[1;5C"]).line)).toBe("git| log --all")
    // From a space, on past the next word; with Ctrl, Alt and Shift too.
    expect(shown(keys(["git log --all", "\x01", "\x1b[1;5C", "\x1b[1;7C"]).line)).toBe(
      "git log| --all",
    )
    // Shift alone moves a character.
    expect(shown(keys(["git log", "\x1b[1;2D"]).line)).toBe("git lo|g")
  })

  it("cuts with Ctrl+U, Ctrl+K and Ctrl+W, and Alt+Backspace", () => {
    expect(shown(keys(["git log", left, left, "\x15"]).line)).toBe("|og")
    expect(shown(keys(["git log", left, left, "\x0b"]).line)).toBe("git l|")
    expect(shown(keys(["git log  ", "\x17"]).line)).toBe("git |")
    expect(shown(keys(["git log", left, "\x17"]).line)).toBe("git |g")
    expect(shown(keys(["git log", "\x1b\x7f"]).line)).toBe("git |")
    expect(shown(keys(["git log", "\x1b\b"]).line)).toBe("git |")
    // Ctrl+Delete deletes the word after the cursor; Shift+Delete one character.
    expect(shown(keys(["git log --all", "\x01", "\x1b[3;5~"]).line)).toBe("| log --all")
    expect(shown(keys(["git log", "\x01", "\x1b[3;2~"]).line)).toBe("|it log")
  })

  it("clears the draft on Ctrl+C", () => {
    expect(keys(["git log", "\x03"])).toEqual({ line: emptyLine(), events: [] })
    // A recalled line cleared is a new draft: ↑ starts again from the newest.
    const { line } = keys(["ls\r", "pwd\r", up, up, "\x03", up])
    expect(shown(line)).toBe("pwd|")
  })

  it("submits on Enter a line with something in it, clearing the draft", () => {
    const { line, events } = keys(["ls -la", "\r"])
    expect(events).toEqual([{ type: "submit", line: "ls -la" }])
    expect(shown(line)).toBe("|")
    // What follows Enter in the same chunk is the next line's.
    expect(keys(["one\rtwo"])).toMatchObject({
      events: [{ type: "submit", line: "one" }],
      line: { draft: "two" },
    })
    // As typed, spaces and all: the terminal trims what it needs to.
    expect(keys(["  hi ", "\r"]).events).toEqual([{ type: "submit", line: "  hi " }])
    // Ctrl+J, and a line break as CR LF, are one Enter.
    expect(keys(["ls\n"]).events).toEqual([{ type: "submit", line: "ls" }])
    expect(keys(["ls\r\n"]).events).toEqual([{ type: "submit", line: "ls" }])
    // A blank line submits nothing, as the form's did, and keeps what it had.
    expect(keys(["\r"]).events).toEqual([])
    expect(keys(["   ", "\r"])).toMatchObject({ events: [], line: { draft: "   " } })
  })

  it("walks the submitted lines with ↑ and ↓, back to the draft it left", () => {
    let { line } = keys(["ls\r", "pwd\r", "pwd\r", "git st"])
    // A line repeated at once is kept once.
    expect(line.history).toEqual(["ls", "pwd"])
    line = keys([up], line).line
    expect(shown(line)).toBe("pwd|")
    line = keys([up, up], line).line
    expect(shown(line)).toBe("ls|")
    line = keys([down], line).line
    expect(shown(line)).toBe("pwd|")
    line = keys([down], line).line
    expect(shown(line)).toBe("git st|")
    // ↓ with nothing recalled, and ↑ with no history, change nothing.
    expect(keys([down], line).line).toBe(line)
    expect(keys([up]).line).toEqual(emptyLine())
    // A recalled line edited is a draft again, and Enter submits it as one.
    const { events } = keys([up, up, " -la", "\r"], line)
    expect(events).toEqual([{ type: "submit", line: "ls -la" }])
    // Seeded, as from the terminal's own commands.
    expect(shown(keys([up], emptyLine(["make"])).line)).toBe("make|")
    // Kept to the last hundred, seeded or submitted.
    const many = Array.from({ length: 120 }, (_, n) => `echo ${n}`)
    expect(emptyLine(many).history).toEqual(many.slice(-100))
    expect(keys(["one more\r"], emptyLine(many)).line.history).toEqual([
      ...many.slice(-99),
      "one more",
    ])
  })

  it("inserts a bracketed paste as text, never submitting", () => {
    expect(keys(["\x1b[200~echo one\r\necho two\x1b[201~"])).toMatchObject({
      events: [],
      line: { draft: "echo one echo two" },
    })
    expect(shown(keys(["ab", left, "\x1b[200~X\x1b[201~"]).line)).toBe("aX|b")
    // Control characters in it drop; a paste whose end never came takes the rest.
    expect(keys(["\x1b[200~a\x1bb\tc\x1b[201~"]).line.draft).toBe("abc")
    expect(keys(["\x1b[200~tail"]).line.draft).toBe("tail")
  })

  it("tells a chunk that is exactly ESC as Escape, leaving the draft", () => {
    expect(keys(["draft", "\x1b"])).toMatchObject({
      events: [{ type: "escape" }],
      line: { draft: "draft" },
    })
    // ESC as part of a key's sequence, or Alt with a key, is no Escape.
    expect(keys([up, "\x1bx", "a\x1b"]).events).toEqual([])
    expect(keys(["\x1bx"]).line.draft).toBe("")
  })

  it("ignores the keys a TUI doesn't type: Tab, focus reports, unknown sequences", () => {
    expect(keys(["a\tb", "\x1b[I", "\x1b[O", "\x1b[15~", "\x1b[201~"]).line.draft).toBe("ab")
  })

  it("types nothing of what the emulator answers on its own", () => {
    const replies = [
      // Device attributes, a mode report, the mouse, a cursor position, a colour.
      "\x1b[?1;2c",
      "\x1b[?2004;1$y",
      "\x1b[<0;10;5M",
      "\x1b[12;40R",
      "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
      "\x1b]10;rgb:ffff/ffff/ffff\x07",
    ]
    expect(keys(["ab", ...replies, "c"]).line.draft).toBe("abc")
    expect(keys([`ab${replies.join("")}c`]).line.draft).toBe("abc")
  })

  it("puts a line it couldn't take back in front of what was typed since", () => {
    const { line } = keys(["2 3\rx"])
    expect(shown(restoreLine(line, "2 3"))).toBe("2 3x|")
    // The cursor stays in what was typed since, and the line is a draft, not a recalled one.
    const restored = restoreLine(keys(["2 3\rxy", left]).line, "2 3")
    expect(shown(restored)).toBe("2 3x|y")
    expect(restored.recalled).toBeNull()
  })

  it("adds the words an interrupted turn gives back, as the form did", () => {
    expect(shown(withReturnedWords(keys(["and then"]).line, "fix the tests"))).toBe(
      "and then fix the tests|",
    )
    expect(shown(withReturnedWords(emptyLine(), "fix the tests"))).toBe("fix the tests|")
  })
})
