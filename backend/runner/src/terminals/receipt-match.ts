import { withoutDoorbell } from "@novadeck/harness-core/prompts"
import { normalisedText, shellCommand } from "@novadeck/protocol"

/**
 * How a prompt given through `agents.prompt` is found in its agent's record, and when it
 * counts as missing there (see `Receipts`). Pure, so every case is a unit test.
 */

/**
 * The lines a prompt's text is matched by, on either side: line breaks as line feeds,
 * Novadeck's doorbell and Inbox reply lines taken out (a harness may record one beside the
 * person's words, as Antigravity merges a ring queued behind a turn into its next input),
 * each line's trailing white space dropped, and blank lines at either end dropped. A shell
 * send is `!` and its command, as Claude Code and Codex record one. Empty for text with no
 * words left.
 */
export const promptLines = (text: string): readonly string[] => {
  const normal = normalisedText(text)
  const shell = shellCommand(normal)
  const words = shell === undefined ? withoutDoorbell(normal) : `!${shell}`
  const lines = words.split("\n").map((line) => line.trimEnd())
  let first = 0
  let last = lines.length
  while (first < last && lines[first]!.trim() === "") first += 1
  while (last > first && lines[last - 1]!.trim() === "") last -= 1
  return lines.slice(first, last)
}

/** Where a run of `needle` starts in `lines` at or after `from`; -1 where it doesn't. */
const runAt = (lines: readonly string[], needle: readonly string[], from: number): number => {
  if (needle.length === 0) return -1
  for (let at = from; at + needle.length <= lines.length; at += 1)
    if (needle.every((line, offset) => lines[at + offset]!.trim() === line.trim())) return at
  return -1
}

/** A prompt still waiting for its record: its ref, and its lines (`promptLines`). */
export type Waiting = { readonly ref: string; readonly lines: readonly string[] }

/**
 * The prompts a user item of the record settles, of `waiting` in the order they were sent:
 * each whose lines are a run of the item's, at or after where the one before ended. One item
 * may settle several, as Antigravity joins prompts queued behind a turn into one input, a
 * line break between each; a prompt not found is passed over, so one the record dropped
 * holds back none sent after it. The caller gives only prompts the item is new to (gained
 * after each was sent), and a prompt settles once.
 */
export const settledBy = (waiting: readonly Waiting[], item: string): readonly string[] => {
  const lines = promptLines(item)
  const settled: string[] = []
  let cursor = 0
  for (const prompt of waiting) {
    const at = runAt(lines, prompt.lines, cursor)
    if (at < 0) continue
    settled.push(prompt.ref)
    cursor = at + prompt.lines.length
  }
  return settled
}

/** A text without its white space. */
const compact = (text: string): string => text.replace(/\s+/g, "")

/**
 * Whether the agent's input box holds a prompt's words, as its screen shows them: all its
 * text, white space aside, as a box wraps long lines and draws its own indent.
 */
export const inBox = (box: string, lines: readonly string[]): boolean => {
  const words = compact(lines.join(""))
  return words !== "" && compact(box).includes(words)
}

/** A prompt whose words may be in the box: as given, and its lines (`promptLines`). */
export type Back = { readonly text: string; readonly lines: readonly string[] }

/**
 * The words of `back`, as given, in the box's order and a line break between, where they are all
 * the box's `text`, white space aside; undefined where the box holds anything else, or none of them. Anything
 * beside them is the person's, and the box isn't Novadeck's to empty.
 */
export const knownWords = (back: readonly Back[], text: string): string | undefined => {
  let rest = compact(text)
  const words: { readonly at: number; readonly text: string }[] = []
  for (const prompt of back) {
    const own = compact(prompt.lines.join(""))
    const at = own === "" ? -1 : rest.indexOf(own)
    if (at < 0) continue
    rest = rest.slice(0, at) + "\0".repeat(own.length) + rest.slice(at + own.length)
    words.push({ at, text: prompt.text })
  }
  if (words.length === 0 || rest.replaceAll("\0", "") !== "") return undefined
  return words
    .toSorted((a, b) => a.at - b.at)
    .map((word) => word.text)
    .join("\n")
}

/** What the deadline reads of the root agent's turns. */
export type Turns = {
  /** Whether its turn runs now. */
  readonly working: boolean
  /** When its latest turn ended, where one did; null while one runs, or before any ended. */
  readonly endedAt: number | null
}

/**
 * When a prompt sent at `sentAt`, which its record doesn't hold yet, counts as missing there:
 * once the agent has been idle for `slackMs` since the later of the send and its latest
 * turn's end, and the record has been read to its end once that slack passed (`readAt`, the
 * latest time it was). A turn that runs puts it off, so a prompt the harness takes into the running
 * turn (Codex steers it, Claude Code takes it beside a tool's result) or runs as the next
 * turn (Claude Code's and Antigravity's queue) has that turn to show; a turn that starts
 * within the slack of the one before puts it off too, and its own end starts the slack
 * again. An agent that never started a turn after the send has the slack from the send.
 * `slackMs` is the doorbell's own wait for a prompt's hook (`confirmMs`), as a turn's start
 * is told by a hook its shell may hold back. Returns `true` when missing now, else the time
 * to look again, or null while a turn runs or the record isn't read that far.
 */
export const missingAt = (
  sentAt: number,
  turns: Turns,
  readAt: number | null,
  now: number,
  slackMs: number,
): true | number | null => {
  if (turns.working) return null
  const since = Math.max(sentAt, turns.endedAt ?? Number.NEGATIVE_INFINITY)
  const due = since + slackMs
  if (now < due) return due
  // Read to its end only before then: what the turn wrote last may not be read yet.
  return readAt !== null && readAt >= due ? true : null
}
