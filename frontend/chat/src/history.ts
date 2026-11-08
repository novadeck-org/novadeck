import type { ChatItem } from "@novadeck/core/conversation"
import { shellCommand } from "@novadeck/core/conversation/prompt-refusal"
import { isCodexAnswer } from "@novadeck/core/harnesses"

import type { SentBubble } from "./bubbles"

// Walking back through what the person sent the agent, as a shell's history does: Up to an
// earlier prompt, Down toward the newest and then to the words that were being typed.

// The place an image had in a prompt, which the harness writes into the words (Claude Code and
// Codex both); the image is not in the box again, so the mark would mislead.
const imageMark = /\s*\[Image #\d+\]\s*/g

// A shell command the person sent from this chat, and when: kept by the app for the terminal,
// as not every harness records it (Antigravity never does, the others once it has run).
export type SentShell = { readonly text: string; readonly at: number }

// How far a recorded command's time may fall before the one it was sent at, in milliseconds:
// records keep whole seconds at the coarsest.
const clockSlackMs = 2_000

// What a text runs, were it a shell command.
const command = (text: string): string => shellCommand(text) ?? text

type Entry = { readonly text: string; readonly at: number | null }

// The prompts the person gave the agent, oldest first: the words of its recorded turns, with
// those sent and not recorded yet (`bubbles`) and the shell commands sent from the chat
// (`shells`) each placed before the first record made after them, or last where that isn't
// known. A shell command the record has too (as `!cmd`) is there once. Left out are what the
// person didn't write (a doorbell line, an interruption's note, another agent's message,
// Codex's answer to a question), a cut-short record, and the words `opens` says call up a
// harness menu when put in the box, which would start that menu in the terminal. A prompt
// that repeats the one before is there once.
export const promptsOf = (
  items: readonly ChatItem[],
  bubbles: readonly SentBubble[],
  shells: readonly SentShell[],
  agent: string | null,
  opens: (text: string) => boolean,
): readonly string[] => {
  const recorded: Entry[] = items
    .filter(
      (item) =>
        item.role === "user" &&
        item.kind === "text" &&
        !item.interrupted &&
        item.ring === null &&
        !item.truncated &&
        !(agent === "codex" && isCodexAnswer(item.text)),
    )
    .map(({ text, at }) => ({ text, at }))
  const recordedShell = (shell: SentShell): boolean =>
    recorded.some(
      ({ text, at }) =>
        text.startsWith("!") &&
        command(text) === command(shell.text) &&
        (at === null || at >= shell.at - clockSlackMs),
    )
  const later: Entry[] = [
    ...bubbles.map(({ text, at }) => ({ text, at })),
    ...shells.filter((shell) => !recordedShell(shell)),
  ].toSorted((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
  const ordered: Entry[] = []
  for (const entry of recorded) {
    while (entry.at !== null && later[0]?.at != null && later[0].at < entry.at)
      ordered.push(later.shift()!)
    ordered.push(entry)
  }
  ordered.push(...later)
  const prompts: string[] = []
  for (const { text: each } of ordered) {
    const text = each.replace(imageMark, " ").trim()
    if (text === "" || opens(text) || text === prompts.at(-1)) continue
    prompts.push(text)
  }
  return prompts
}

// Where the person is in the history: `at` counts back from the newest prompt (0 is the
// newest), `shown` is the prompt in the box, and `typed` what the box held before the walk.
export type Walk = { readonly at: number; readonly shown: string; readonly typed: string }

export type Recall = { readonly walk: Walk | null; readonly draft: string }

// Whether a key in the box walks the history rather than moves the caret. While a walk shows
// its prompt in the box, Up and Down both walk, wherever the caret is. Otherwise only Up
// starts one, and only from the very start of the box (empty, or the caret at its beginning,
// which a native Up from the first row of a long prompt gets to), so no key is taken from a
// caret that has a row to move along.
export const walksAt = (
  walk: Walk | null,
  key: "ArrowUp" | "ArrowDown",
  draft: string,
  start: number,
  end: number,
): boolean =>
  (walk !== null && walk.shown === draft) || (key === "ArrowUp" && start === 0 && end === 0)

// The box after one step, or null where the key has no step to make. The walk holds only while
// the box still shows what it put there: any other words, an edit, a send or another agent's
// draft, begin a fresh walk from them.
export const recall = (
  prompts: readonly string[],
  walk: Walk | null,
  draft: string,
  key: "ArrowUp" | "ArrowDown",
): Recall | null => {
  const on = walk !== null && walk.shown === draft ? walk : null
  if (key === "ArrowDown") {
    if (on === null) return null
    if (on.at === 0) return { walk: null, draft: on.typed }
    const shown = prompts.at(prompts.length - on.at)!
    return { walk: { at: on.at - 1, shown, typed: on.typed }, draft: shown }
  }
  const at = on === null ? 0 : on.at + 1
  const shown = prompts.at(-1 - at)
  if (shown === undefined) return null
  return { walk: { at, shown, typed: on?.typed ?? draft }, draft: shown }
}
