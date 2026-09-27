import type { IDisposable, Terminal } from "@xterm/xterm"

// Window reports (XTWINOPS) that ask for an answer: state, position, sizes and titles.
const windowReports = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21])

const swallow = (): boolean => true

// The runner's own screen already answers what programs ask the terminal, such as
// device attributes or the cursor position. A browser xterm must not answer too, or
// programs read every reply twice, and once more for output replayed after a
// reconnection. Colour queries (OSC 4, 10, 11…) are the exception: the runner's screen
// has no theme and leaves them unanswered, so the browser answers them from its own.
export const silenceQueries = (xterm: Terminal): IDisposable => {
  const { parser } = xterm
  const handlers: IDisposable[] = [
    // Primary, secondary and tertiary device attributes.
    parser.registerCsiHandler({ final: "c" }, swallow),
    parser.registerCsiHandler({ prefix: ">", final: "c" }, swallow),
    parser.registerCsiHandler({ prefix: "=", final: "c" }, swallow),
    // Status and cursor position reports, ANSI and DEC.
    parser.registerCsiHandler({ final: "n" }, swallow),
    parser.registerCsiHandler({ prefix: "?", final: "n" }, swallow),
    // Mode reports (DECRQM), ANSI and DEC.
    parser.registerCsiHandler({ intermediates: "$", final: "p" }, swallow),
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, swallow),
    // Terminal name and version (XTVERSION), and the keyboard protocol flags.
    parser.registerCsiHandler({ prefix: ">", final: "q" }, swallow),
    parser.registerCsiHandler({ prefix: "?", final: "u" }, swallow),
    // Window reports; other window operations still reach xterm.
    parser.registerCsiHandler({ final: "t" }, (params) => {
      const first = params[0]
      return typeof first === "number" && windowReports.has(first)
    }),
    // Setting requests (DECRQSS).
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, swallow),
  ]
  return { dispose: () => handlers.forEach((handler) => handler.dispose()) }
}
