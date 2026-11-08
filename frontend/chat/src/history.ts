import type { ChatItem } from "@novadeck/core/conversation"

import type { SentBubble } from "./bubbles"

// Walking back through what the person sent the agent, as a shell's history does: Up to an
// earlier prompt, Down toward the newest and then to the words that were being typed.

// The place an image had in a prompt, which the harness writes into the words (Claude Code and
// Codex both); the image is not in the box again, so the mark would mislead.
const imageMark = /\[Image #\d+\]/g

// How Codex records the person's answer to an async question: as a prompt, its question first.
const codexAnswer = /^Re: [^\n]*\n/

// The prompts the person gave the agent, oldest first: the words of its recorded turns, a shell
// command as `!cmd`, then those sent and not recorded yet (`bubbles`, which hold the person's
// words in the order they were given). Left out are what the person didn't write (a doorbell
// line, an interruption's note, another agent's message, an answer to a question), a cut-short
// record, and the words `opens` says call up a harness menu when put in the box, which would
// start that menu in the terminal. A prompt that repeats the one before is there once.
export const promptsOf = (
  items: readonly ChatItem[],
  bubbles: readonly SentBubble[],
  agent: string | null,
  opens: (text: string) => boolean,
): readonly string[] => {
  const recorded = items
    .filter(
      (item) =>
        item.role === "user" &&
        item.kind === "text" &&
        !item.interrupted &&
        item.ring === null &&
        !item.truncated &&
        !(agent === "codex" && codexAnswer.test(item.text)),
    )
    .map((item) => item.text)
  const sent = bubbles.map(({ text }) => text)
  const prompts: string[] = []
  for (const each of [...recorded, ...sent]) {
    const text = each.replace(imageMark, "").trim()
    if (text === "" || opens(text) || text === prompts.at(-1)) continue
    prompts.push(text)
  }
  return prompts
}

// Where the person is in the history: `at` counts back from the newest prompt (0 is the
// newest), `shown` is the prompt in the box, and `typed` what the box held before the walk.
export type Walk = { readonly at: number; readonly shown: string; readonly typed: string }

export type Recall = { readonly walk: Walk | null; readonly draft: string }

// Whether a key in the box walks the history rather than moves the caret: Up from the first
// line, Down from the last, and with a selection neither.
export const walksAt = (
  key: "ArrowUp" | "ArrowDown",
  text: string,
  start: number,
  end: number,
): boolean =>
  start === end &&
  (key === "ArrowUp" ? !text.slice(0, start).includes("\n") : !text.slice(end).includes("\n"))

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
