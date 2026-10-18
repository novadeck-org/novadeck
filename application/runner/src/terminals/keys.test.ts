import type { Reporting } from "@novadeck/emulator/headless"

import { describe, expect, it } from "../test.js"
import { splitReports } from "./keys.js"

const off: Reporting = { mouse: null, focus: false }
const sgr: Reporting = { mouse: "sgr", focus: true }

describe("a write's reports", () => {
  it("hold the mouse's wheel and motion with the person's keys on request, never the rest", () => {
    // A wheel report, a motion report, a focus-in and a cursor-position answer.
    const data = "\x1b[<64;5;5M\x1b[<35;6;6M\x1b[I\x1b[12;40R"
    expect(splitReports(data, sgr, true)).toEqual({
      reports: "\x1b[I\x1b[12;40R",
      typed: "",
      mouse: "\x1b[<64;5;5M\x1b[<35;6;6M",
    })
    expect(splitReports(data, sgr)).toEqual({ reports: data, typed: "", mouse: "" })
  })

  it("are told apart from the person's keys, which keep their order", () => {
    // A cursor-position report, a device-attributes answer and a focus-in the TUI asked for.
    expect(splitReports("a\x1b[12;40Rb\x1b[?62;4cc\x1b[I\r", sgr)).toEqual({
      reports: "\x1b[12;40R\x1b[?62;4c\x1b[I",
      typed: "abc\r",
      mouse: "",
    })
    // A focus report the TUI never asked for is the person's keys.
    expect(splitReports("\x1b[I", off)).toEqual({ reports: "", typed: "\x1b[I", mouse: "" })
    // A paste is the person's whole, whatever it holds.
    expect(splitReports("\x1b[200~x\x1b[12;40Ry\x1b[201~", sgr)).toEqual({
      reports: "",
      typed: "\x1b[200~x\x1b[12;40Ry\x1b[201~",
      mouse: "",
    })
  })
})
