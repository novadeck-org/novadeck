import type { Terminal } from "@xterm/headless"

import type { Reporting } from "./keys.js"

/**
 * How a terminal encodes the mouse's reports: X10's bytes by default, or SGR's
 * parameters, in cells or in pixels. xterm.js keeps its own to itself. `urxvt` is the
 * default while a program asked for urxvt's encoding (1015) besides: xterm.js 6 ignores
 * it and goes on reporting in X10, which a TUI that reads only urxvt's may take as typing.
 */
export type MouseEncoding = "default" | "sgr" | "sgr-pixels" | "urxvt"

/**
 * Follows the mouse's encoding a program sets on `screen`, as xterm.js does: DECSET and
 * DECRST 1006 and 1016, and a full reset; and urxvt's 1015, which xterm.js ignores. Its
 * handlers let xterm.js handle each sequence too. Returns the current encoding.
 */
export const watchMouseEncoding = (screen: Terminal): (() => MouseEncoding) => {
  let encoding: Exclude<MouseEncoding, "urxvt"> = "default"
  let urxvt = false
  const set = (on: boolean) => (params: (number | number[])[]) => {
    for (const param of params) {
      if (param === 1006) encoding = on ? "sgr" : "default"
      if (param === 1016) encoding = on ? "sgr-pixels" : "default"
      if (param === 1015) urxvt = on
    }
    return false
  }
  screen.parser.registerCsiHandler({ prefix: "?", final: "h" }, set(true))
  screen.parser.registerCsiHandler({ prefix: "?", final: "l" }, set(false))
  screen.parser.registerEscHandler({ final: "c" }, () => {
    encoding = "default"
    urxvt = false
    return false
  })
  return () => (urxvt && encoding === "default" ? "urxvt" : encoding)
}

/**
 * Which of the mouse's reports the person's keys may leave out, by the screen's tracking
 * mode and encoding: none while it tracks no mouse, or the TUI may read X10's as typing.
 */
export const mouseReporting = (
  tracking: "none" | "x10" | "vt200" | "drag" | "any",
  encoding: MouseEncoding,
): Reporting["mouse"] => {
  if (tracking === "none" || encoding === "urxvt") return null
  return encoding === "default" ? "x10" : "sgr"
}

/** What restores `encoding` on a fresh terminal, which starts with the default. */
export const restoreMouseEncoding = (encoding: MouseEncoding): string =>
  encoding === "sgr" ? "\x1b[?1006h" : encoding === "sgr-pixels" ? "\x1b[?1016h" : ""
