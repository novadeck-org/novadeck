import headless from "@xterm/headless"

import { describe, expect, it } from "../test.js"
import { mouseReporting, watchMouseEncoding } from "./mouse.js"

const { Terminal } = headless

// xterm.js's own encoding, which it keeps to itself; the watcher must agree with it.
const internal = (screen: InstanceType<typeof Terminal>): string =>
  // eslint-disable-next-line no-underscore-dangle -- Its only way out is its internals.
  (screen as unknown as { _core: { coreMouseService: { activeEncoding: string } } })._core
    .coreMouseService.activeEncoding

describe("the mouse's encoding on a screen", () => {
  it("follows what a program sets, as xterm.js does", async () => {
    const screen = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    const encoding = watchMouseEncoding(screen)
    const steps: readonly (readonly [string, string, string])[] = [
      ["", "default", "DEFAULT"],
      ["\x1b[?1000h\x1b[?1006h", "sgr", "SGR"],
      ["\x1b[?1006l", "default", "DEFAULT"],
      ["\x1b[?1003;1016h", "sgr-pixels", "SGR_PIXELS"],
      ["\x1b[?1006h", "sgr", "SGR"],
      // Turning off one it no longer uses still goes back to the default, as in xterm.js.
      ["\x1b[?1016l", "default", "DEFAULT"],
      ["\x1b[?1006;1016h", "sgr-pixels", "SGR_PIXELS"],
      // A full reset; a soft one leaves it.
      ["\x1b[!p", "sgr-pixels", "SGR_PIXELS"],
      ["\x1bc", "default", "DEFAULT"],
      // UTF-8's, which xterm.js doesn't support.
      ["\x1b[?1005h", "default", "DEFAULT"],
    ]
    try {
      for (const [data, expected, xterm] of steps) {
        // eslint-disable-next-line no-await-in-loop -- Each step follows the last.
        await new Promise<void>((resolve) => screen.write(data, resolve))
        expect([encoding(), internal(screen)]).toEqual([expected, xterm])
      }
    } finally {
      screen.dispose()
    }
  })

  it("agrees with xterm.js across the screen's other sequences", async () => {
    const cases: readonly (readonly [string, readonly string[], string, string])[] = [
      // The alternate screen, in and out, keeps it.
      ["alternate screen", ["\x1b[?1000h\x1b[?1006h\x1b[?1049h\x1b[?1049l"], "sgr", "SGR"],
      // A query of the mode (DECRQM) changes nothing.
      ["DECRQM", ["\x1b[?1000h\x1b[?1006h\x1b[?1006$p"], "sgr", "SGR"],
      // A sub-parameter still names the mode.
      ["sub-parameter", ["\x1b[?1000h\x1b[?1006:1h"], "sgr", "SGR"],
      // A sequence split across writes, as a pty may hand it over.
      ["split write", ["\x1b[?1000h\x1b[?10", "06h"], "sgr", "SGR"],
    ]
    for (const [name, writes, expected, xterm] of cases) {
      const screen = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
      const encoding = watchMouseEncoding(screen)
      try {
        for (const data of writes)
          // eslint-disable-next-line no-await-in-loop -- Each write follows the last.
          await new Promise<void>((resolve) => screen.write(data, resolve))
        expect([name, encoding(), internal(screen)]).toEqual([name, expected, xterm])
      } finally {
        screen.dispose()
      }
    }
  })

  it("tells urxvt's encoding, which xterm.js ignores, from X10 while SGR is off", async () => {
    const screen = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    const encoding = watchMouseEncoding(screen)
    const steps: readonly (readonly [string, string, string])[] = [
      // xterm.js goes on reporting in X10, which a TUI that reads urxvt's may take as typing.
      ["\x1b[?1000h\x1b[?1015h", "urxvt", "DEFAULT"],
      // SGR, set as well, is what xterm.js sends.
      ["\x1b[?1006h", "sgr", "SGR"],
      ["\x1b[?1006l", "urxvt", "DEFAULT"],
      ["\x1b[?1015l", "default", "DEFAULT"],
      ["\x1b[?1015h\x1bc", "default", "DEFAULT"],
    ]
    try {
      for (const [data, expected, xterm] of steps) {
        // eslint-disable-next-line no-await-in-loop -- Each step follows the last.
        await new Promise<void>((resolve) => screen.write(data, resolve))
        expect([data, encoding(), internal(screen)]).toEqual([data, expected, xterm])
      }
    } finally {
      screen.dispose()
    }
  })
})

describe("the mouse's reports the person's keys leave out", () => {
  it("follow the encoding while the mouse is tracked, and none under urxvt's", () => {
    expect(mouseReporting("none", "sgr")).toBe(null)
    expect(mouseReporting("any", "default")).toBe("x10")
    expect(mouseReporting("vt200", "sgr")).toBe("sgr")
    expect(mouseReporting("drag", "sgr-pixels")).toBe("sgr")
    // Every report counts as typing, as the TUI may read its X10 bytes as such.
    expect(mouseReporting("any", "urxvt")).toBe(null)
  })
})
