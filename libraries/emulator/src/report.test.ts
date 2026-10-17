import { describe, expect, it } from "vitest"

import { matchReport, type Reporting } from "./report.js"

const off: Reporting = { mouse: null, focus: false }
const sgr: Reporting = { mouse: "sgr", focus: true }
const x10: Reporting = { mouse: "x10", focus: true }

describe("a terminal's reply at the start of data", () => {
  it("is nothing when data starts with anything else", () => {
    expect(matchReport("", sgr)).toBeUndefined()
    expect(matchReport("a\x1b[<64;1;1M", sgr)).toBeUndefined()
    expect(matchReport("\x1b[A", sgr)).toBeUndefined()
  })

  it("has the length of the reply alone, with what follows left", () => {
    expect(matchReport("\x1b[<64;40;10Mtyped", sgr)).toEqual({ length: 12, kind: "none" })
    expect(matchReport("\x1b[12;5Rx", off)).toEqual({ length: 7, kind: "none" })
    expect(matchReport("\x1b]11;rgb:0000/0000/0000\x07x", off)).toEqual({
      length: 24,
      kind: "none",
    })
  })

  it("is none for answers to queries, whatever it reports", () => {
    for (const reply of [
      "\x1b[1;1R",
      "\x1b[?6c",
      "\x1b[>0;276;0c",
      "\x1b[0n",
      "\x1b]10;rgb:ff/ff/ff\x1b\\",
    ])
      expect(matchReport(reply, off)).toMatchObject({ kind: "none" })
  })

  it("is none for a wheel or a motion, content for a click, while the mouse is reported", () => {
    expect(matchReport("\x1b[<65;4;4M", sgr)?.kind).toBe("none")
    expect(matchReport("\x1b[<35;4;4M", sgr)?.kind).toBe("none")
    expect(matchReport("\x1b[<0;4;4M", sgr)?.kind).toBe("content")
    expect(matchReport("\x1b[<0;4;4m", sgr)?.kind).toBe("content")
    expect(matchReport("\x1b[M`!!", x10)?.kind).toBe("none")
    expect(matchReport("\x1b[M !!", x10)?.kind).toBe("content")
  })

  it("is keys for a report the program didn't ask for, or in another encoding", () => {
    expect(matchReport("\x1b[<64;4;4M", off)?.kind).toBe("keys")
    expect(matchReport("\x1b[<64;4;4M", x10)?.kind).toBe("keys")
    expect(matchReport("\x1b[M`!!", sgr)?.kind).toBe("keys")
    expect(matchReport("\x1b[I", off)?.kind).toBe("keys")
    expect(matchReport("\x1b[I", sgr)?.kind).toBe("none")
  })

  it("is keys for an X10 report with a byte past ASCII, or below the buttons", () => {
    expect(matchReport("\x1b[M`é!", x10)?.kind).toBe("keys")
    expect(matchReport("\x1b[M\x10!!", x10)?.kind).toBe("keys")
  })
})
