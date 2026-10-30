// What the terminal itself sends. Its answers to queries: cursor-position and device-status
// reports, device attributes, and OSC answers such as a colour's. Mouse reports, SGR
// (`ESC [ < b;x;y M` or `m`) and X10 (`ESC [ M` and three bytes), and focus reports, which
// a full-screen program asks for, so each scroll, move or click over it sends one. xterm's F3
// with a modifier (`CSI 1;5 R`) reads as a cursor-position report and is left out too;
// harmless, as F3 types nothing.
const report =
  // eslint-disable-next-line no-control-regex -- Escape sequences are what it reads.
  /^\x1b(?:\[(?:<(?<sgr>\d+);\d+;\d+[Mm]|M(?<x10>[\s\S])[\s\S]{2}|(?<focus>[IO])|\??[\d;]*[Rcn]|>[\d;]*c)|\][^\x07\x1b]*(?:\x07|\x1b\\))/

/**
 * Which reports a program asked its terminal for, as a screen of it shows: the mouse's, in
 * the encoding it reads (null while it tracks no mouse), and the focus's. Until it asks,
 * what looks like one is typed keys.
 */
export type Reporting = { readonly mouse: "sgr" | "x10" | null; readonly focus: boolean }

/**
 * What a report is to the program: `none`, never one of its typed keys; `content`, as a
 * click, which can change what it shows (open a menu); or `keys`, not a report at all: one
 * the program never asked for, one in another encoding than it reads, or an X10 one it may
 * not read whole.
 */
type ReportKind = "none" | "content" | "keys"

const kindOf = (match: RegExpExecArray, reporting: Reporting): ReportKind => {
  const { sgr, x10, focus } = match.groups ?? {}
  if (focus !== undefined) return reporting.focus ? "none" : "keys"
  // Answers to queries, whatever the program asked for.
  if (sgr === undefined && x10 === undefined) return "none"
  if (reporting.mouse !== (sgr !== undefined ? "sgr" : "x10")) return "keys"
  // X10's bytes past ASCII come re-encoded as UTF-8 through the terminal's pty, so the program
  // may read a leftover byte as typing.
  if (x10 !== undefined && /[\u0080-\uffff]/.test(match[0])) return "keys"
  // The button code: SGR's as it is, X10's offset by 32, where a byte below is no button.
  const button = sgr !== undefined ? Number(sgr) : (x10?.charCodeAt(0) ?? 0) - 32
  if (button < 0) return "keys"
  // A wheel (64) or a motion (32) report.
  return (button & (64 | 32)) !== 0 ? "none" : "content"
}

/** The terminal's own reply at the start of `data`, if any, and what it is to the program. */
export const matchReport = (
  data: string,
  reporting: Reporting,
): { readonly length: number; readonly kind: ReportKind } | undefined => {
  const match = report.exec(data)
  return match ? { length: match[0].length, kind: kindOf(match, reporting) } : undefined
}
