import { describe, expect, it } from "../test.js"
import { keysOf, type Reporting } from "./keys.js"

const off: Reporting = { mouse: null, focus: false }
const sgr: Reporting = { mouse: "sgr", focus: true }
const x10: Reporting = { mouse: "x10", focus: true }
const kinds = (data: string, queueKey?: string, reporting: Reporting = off) =>
  keysOf(data, queueKey, reporting).map(({ kind }) => kind)

describe("the person's keys", () => {
  it("submit only with a bare Enter, or the harness's queue key", () => {
    expect(kinds("ok\r")).toEqual(["content", "content", "enter"])
    // Shift or Alt+Enter, as a TUI reads it, is a newline in the box.
    expect(kinds("\x1b\r")).toEqual(["content"])
    // A paste is one key, whatever it holds.
    expect(kinds("\x1b[200~one\rtwo\r\x1b[201~")).toEqual(["content"])
    expect(kinds("\n")).toEqual(["content"])
    // Codex queues with Tab; elsewhere Tab moves, or takes a prompt suggestion.
    expect(kinds("\t", "\t")).toEqual(["queue"])
    expect(kinds("\t")).toEqual(["accept"])
  })

  it("tell the keys that never change the box from those that may", () => {
    // Escape, Left, Home and End.
    expect(kinds("\x1b\x1b[D\x1bOD\x1b[H\x1b[F\x1b[4~")).toEqual(
      Array.from({ length: 6 }, () => "neutral"),
    )
    // Right and Tab take Claude Code's prompt suggestion into an empty box.
    expect(kinds("\x1b[C\x1bOC\x1b[1;5C\t")).toEqual(Array.from({ length: 4 }, () => "accept"))
    // Up and Down recall history; Delete and Backspace change it; so does a hotkey.
    expect(kinds("\x1b[A\x1bOB\x1b[3~\x7fy")).toEqual(Array.from({ length: 5 }, () => "content"))
    // Alt with a key types.
    expect(kinds("\x1bx")).toEqual(["content"])
  })

  it("leave out the mouse's scroll and motion and the focus while the TUI reports them, but take a click", () => {
    // A fullscreen TUI's scroll, as SGR and X10 report it, and a move over it.
    expect(kinds("\x1b[<64;40;10M\x1b[<65;40;10M", undefined, sgr)).toEqual([])
    expect(kinds("\x1b[M`!!", undefined, x10)).toEqual([])
    expect(kinds("\x1b[<35;12;7M", undefined, sgr)).toEqual([])
    // Focus out and in, among keys.
    expect(kinds("\x1b[Oa\x1b[I", undefined, sgr)).toEqual(["content"])
    // A click, pressed and released, may open a menu: input.
    expect(kinds("\x1b[<0;10;5M\x1b[<0;10;5m", undefined, sgr)).toEqual(["content", "content"])
    expect(kinds("\x1b[M !!", undefined, x10)).toEqual(["content"])
    // A key after a report is still a key.
    expect(kinds("\x1b[<65;10;5Mx\r", undefined, sgr)).toEqual(["content", "enter"])
  })

  it("read what looks like a mouse or focus report as keys while the TUI hasn't asked for them", () => {
    // Alt+[ then M and text, not an X10 report.
    expect(kinds("\x1b[Mhi!")).toEqual(["content", "content", "content", "content"])
    expect(kinds("\x1b[<64;40;10M")).not.toEqual([])
    expect(kinds("\x1b[I")).toEqual(["content"])
    expect(kinds("\x1b[Ox")).toEqual(["content", "content"])
    // Each kind of report counts only under its own mode.
    expect(kinds("\x1b[O", undefined, { mouse: "sgr", focus: false })).toEqual(["content"])
    expect(kinds("\x1b[<64;40;10M", undefined, { mouse: null, focus: true })).not.toEqual([])
  })

  it("leave out a mouse report only in the encoding the TUI asked for", () => {
    // A wheel in SGR to a TUI that reads X10, which may type part of it.
    expect(kinds("\x1b[<64;40;10M", undefined, x10)).toEqual(["content"])
    // A wheel in X10 to a TUI that reads SGR, as a client restored without its encoding sends.
    expect(kinds("\x1b[Ma*#", undefined, sgr)).toEqual(Array.from({ length: 4 }, () => "content"))
  })

  it("take an X10 report with a byte past ASCII as keys, as its re-encoding may leave one", () => {
    // A wheel far right, its column byte above 0x7f, raw and as UTF-8 came through.
    expect(kinds("\x1b[Ma\xff#", undefined, x10)).toEqual(
      Array.from({ length: 4 }, () => "content"),
    )
    expect(kinds("\x1b[Ma\xc3\xbf#", undefined, x10)).toEqual(
      Array.from({ length: 5 }, () => "content"),
    )
  })

  it("take a report no terminal it serves sends as keys", () => {
    // urxvt's form, which xterm.js never sends: a key such as Alt+[ then text.
    expect(kinds("\x1b[96;40;10M", undefined, x10)).toEqual(["content"])
    expect(kinds("\x1b[1;2;3M", undefined, sgr)).toEqual(["content"])
    // An X10 button byte below 32 is no button: the keys after it, a real Enter too.
    expect(kinds("\x1b[M\rab", undefined, x10)).toEqual(["content", "enter", "content", "content"])
    expect(kinds("\x1b[M\x01ab", undefined, x10)).toEqual(
      Array.from({ length: 4 }, () => "content"),
    )
  })

  it("leave out the terminal's answers to queries, whatever it reports", () => {
    for (const reporting of [off, sgr, x10]) {
      // Cursor position, device status, device attributes and an OSC colour answer.
      expect(kinds("\x1b[12;40R", undefined, reporting)).toEqual([])
      expect(kinds("\x1b[0n", undefined, reporting)).toEqual([])
      expect(kinds("\x1b[?1;2c\x1b[>0;276;0c", undefined, reporting)).toEqual([])
      expect(kinds("\x1b]11;rgb:0000/0000/0000\x07", undefined, reporting)).toEqual([])
      expect(kinds("\x1b]10;rgb:ffff/ffff/ffff\x1b\\", undefined, reporting)).toEqual([])
      // Among keys, the keys stay.
      expect(kinds("a\x1b[12;40Rb\r", undefined, reporting)).toEqual([
        "content",
        "content",
        "enter",
      ])
      expect(kinds("\x1b[?1;2cx", undefined, reporting)).toEqual(["content"])
      expect(kinds("\x1b]11;rgb:0/0/0\x07\x1b", undefined, reporting)).toEqual(["neutral"])
    }
  })
})
