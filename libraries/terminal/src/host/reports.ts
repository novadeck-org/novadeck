import { matchReport, type Reporting } from "@novadeck/emulator/headless"

/**
 * A write split into the terminal's own reports (answers to its queries, focus and wheel
 * reports the TUI asked for), which are never held back, and the rest, the person's keys
 * and pastes, in their order. With `holdMouse`, the mouse's wheel and motion reports come
 * apart as `mouse`, for the caller to drop: a TUI that tracks the mouse (Claude Code's and
 * Codex's do) would take them as the person's hand over a dialog being answered, and
 * replayed later, once tracking may be off, they would read as keys.
 */
export const splitReports = (
  data: string,
  reporting: Reporting,
  holdMouse = false,
): { readonly reports: string; readonly typed: string; readonly mouse: string } => {
  let reports = ""
  let mouse = ""
  let typed = ""
  let at = 0
  while (at < data.length) {
    const rest = data.slice(at)
    if (rest.startsWith("\x1b[200~")) {
      const end = rest.indexOf("\x1b[201~")
      const length = end < 0 ? rest.length : end + 6
      typed += rest.slice(0, length)
      at += length
      continue
    }
    const reported = matchReport(rest, reporting)
    if (reported?.kind === "none") {
      const text = rest.slice(0, reported.length)
      // The mouse's reports start with `ESC [ <` (SGR) or `ESC [ M` (X10).
      // eslint-disable-next-line no-control-regex -- Escape sequences are what it reads.
      if (holdMouse && /^\x1b\[[<M]/.test(text)) mouse += text
      else reports += text
      at += reported.length
      continue
    }
    // One at a time: a report starts where a key sequence ended.
    typed += rest[0]
    at += 1
  }
  return { reports, typed, mouse }
}
