import { shellStateOf, type ShellState } from "@novadeck/core/agents/shells"
import type { ShellEntry, ShellOutput } from "@novadeck/core/items"

// What the shells item shows of a terminal's agent's background shells, as pure rules: their
// order, how each reads, what's said when its output can't show, and the message "Tell" drafts.

// Failed ones first, newest end first; then the running, newest start first; then the rest
// that ended, newest end first.
const rank: Record<ShellState, number> = { failed: 0, running: 1, ended: 2, stopped: 2 }

const recency = (shell: ShellEntry): number => shell.exit?.at ?? shell.since

export const orderedShells = (shells: readonly ShellEntry[]): readonly ShellEntry[] =>
  shells.toSorted(
    (a, b) => rank[shellStateOf(a)] - rank[shellStateOf(b)] || recency(b) - recency(a),
  )

// The header's count: "2 running · 1 failed", then what ended quietly; "no shells" for none.
export const summaryOf = (shells: readonly Pick<ShellEntry, "exit">[]): string => {
  const states = shells.map(shellStateOf)
  const count = (state: ShellState): number => states.filter((each) => each === state).length
  const quiet = count("ended") + count("stopped")
  const parts = [
    count("running") > 0 && `${count("running")} running`,
    count("failed") > 0 && `${count("failed")} failed`,
    quiet > 0 && `${quiet} ended`,
  ].filter((part): part is string => part !== false)
  return parts.length > 0 ? parts.join(" · ") : "none now"
}

// How long a shell has run, in the largest unit that reads plainly.
export const ageText = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}

// How a shell stands, in the words of its row: the time it has run, or how it ended.
export const stateText = (shell: ShellEntry, now: number): string => {
  switch (shellStateOf(shell)) {
    case "running":
      return ageText(now - shell.since)
    case "stopped":
      return "stopped"
    default:
      return `exited ${shell.exit!.code}`
  }
}

// A line without the escape sequences a program prints for colours and the cursor: the runner
// sends output as the shell wrote it.
// eslint-disable-next-line no-control-regex -- escape sequences start with ESC.
const escapes = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g
export const plain = (line: string): string => line.replace(escapes, "")

// The last line of a shell's output that says anything, where it has output to read.
export const lastLineOf = (output: ShellOutput): string | null => {
  if (output.state !== "ready") return null
  const last = output.lines.findLast((line) => plain(line).trim() !== "")
  return last === undefined ? null : plain(last)
}

// Why a shell's output isn't there, in the app's plain voice.
export const missingText = (output: ShellOutput, agent: string): string | null =>
  output.state === "none"
    ? `${agent} ran this in a terminal of its own, which Novadeck can't read. Its reply shows what it read.`
    : output.state === "gone"
      ? `Its output is gone: ${agent} cleared it with its session.`
      : null

// How many of the last lines a folded row shows, and how many while another row is unfolded.
export const foldedLines = 3
export const foldedLinesBesideOpen = 1

// The lines a row shows: the whole tail when unfolded, else its last few.
export const shownLines = (
  lines: readonly string[],
  firstLine: number,
  mode: "open" | "folded" | "beside",
): { readonly firstLine: number; readonly lines: readonly string[] } => {
  if (mode === "open") return { firstLine, lines }
  const keep = mode === "folded" ? foldedLines : foldedLinesBesideOpen
  const lastLines = lines.slice(-keep)
  return { firstLine: firstLine + lines.length - lastLines.length, lines: lastLines }
}

// How many of a failed shell's last lines the draft quotes, and how long each may be.
const quotedLines = 8
const quotedWidth = 240

// The message "Tell" drafts for the person to look over: the command, its exit code and the
// end of its output. Never sent.
export const tellText = (shell: ShellEntry): string => {
  const code = shell.exit?.code
  const head = `\`${shell.command}\` ${code === null || code === undefined ? "stopped" : `exited ${code}`}.`
  if (shell.output.state !== "ready") return head
  const tail = shell.output.lines
    .map(plain)
    .filter((line) => line.trim() !== "")
    .slice(-quotedLines)
    .map((line) => (line.length > quotedWidth ? `${line.slice(0, quotedWidth - 1)}…` : line))
  return tail.length > 0 ? `${head} The end of its output:\n\n${tail.join("\n")}` : head
}
