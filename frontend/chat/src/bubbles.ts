import type { ChatPrompt } from "@novadeck/core/conversation"
import type { ChatBlock } from "@novadeck/core/conversation/turns"

import type { Attachment } from "./attachments"
import type { Echo } from "./echoes"
import { keptDraftOf, keptImagesOf, type ChatSend } from "./sends"

// A prompt the chat shows as the person's before, or instead of, the agent's record showing
// it: `queued` behind a prompt still on its way; `sending` on its way, or sent and not in the
// record yet; `unrecorded`, sent, and the record never got it; `in-box`, not in the record,
// and back in the agent's own box. `at` is when it was sent, on the backend's clock; null
// while it hasn't been. `images` are the ones this window sent with it, shown until the record
// holds the turn.
export type SentBubble = {
  readonly ref: string
  readonly text: string
  readonly images: readonly Attachment[]
  readonly state: "queued" | "sending" | "unrecorded" | "in-box"
  readonly at: number | null
}

const noImages: readonly Attachment[] = []

// The prompts to show as bubbles, in the order they were given: those the conversation's
// receipts tell (`prompts`), as any window shows them, then this window's own still on their
// way. A settled one shows until the conversation holds its item (`items` long), which may
// arrive after the receipt, and a withdrawn one shows not at all: its words are the draft
// again. A settled one whose words aren't known, from the receipt or this window's own
// send, shows not at all.
export const sentBubbles = (
  sends: readonly ChatSend[],
  prompts: readonly ChatPrompt[],
  items: number,
): readonly SentBubble[] => {
  const told = new Set(prompts.map(({ ref }) => ref))
  const local = new Map(sends.map((send) => [send.ref, send]))
  // What a prompt of images shows reads as its draft did, the placeholders in the words.
  const textOf = (prompt: ChatPrompt): string | undefined => {
    const send = local.get(prompt.ref)
    const drafted =
      send && send.images.length > 0 ? send.draft.trim() : keptDraftOf(prompt.ref)?.trim()
    return drafted ?? prompt.text ?? send?.text
  }
  const fromReceipts = prompts.flatMap((prompt): SentBubble[] => {
    const text = textOf(prompt)
    if (text === undefined) return []
    const { ref, sentAt: at } = prompt
    const images = local.get(ref)?.images ?? keptImagesOf(ref) ?? noImages
    switch (prompt.state) {
      case "withdrawn":
        return []
      case "settled":
        return prompt.item !== null && items > prompt.item
          ? []
          : [{ ref, text, images, state: "sending", at }]
      case "pending":
        return [{ ref, text, images, state: "sending", at }]
      case "unrecorded":
      case "in-box":
        return [{ ref, text, images, state: prompt.state, at }]
    }
  })
  const ownLeft = sends
    .filter((send) => send.to === null && send.phase !== "settled" && !told.has(send.ref))
    .map((send): SentBubble => ({
      ref: send.ref,
      text: send.images.length > 0 ? send.draft.trim() : send.text,
      images: send.images,
      state: send.phase === "queued" ? "queued" : "sending",
      at: null,
    }))
  return [...fromReceipts, ...ownLeft]
}

// When a block was recorded, where its harness said: tool runs and notes take none.
export const blockAt = (block: ChatBlock): number | null =>
  block.kind === "user" || block.kind === "assistant" || block.kind === "agent" ? block.at : null

// What stands among the blocks by when it went: the person's prompt not in the record yet, or a
// command run through a harness's own menu, which the record mostly keeps no item of.
export type Placed =
  | { readonly kind: "block"; readonly block: ChatBlock }
  | { readonly kind: "sent"; readonly bubble: SentBubble }
  | { readonly kind: "echo"; readonly echo: Echo }

const noEchoes: readonly Echo[] = []

// The bubbles and the echoes as one line, in the order they went: a bubble not sent yet after
// every echo.
const asides = (
  bubbles: readonly SentBubble[],
  echoes: readonly Echo[],
): readonly Exclude<Placed, { kind: "block" }>[] => {
  const merged: Exclude<Placed, { kind: "block" }>[] = []
  let bubble = 0
  let echo = 0
  while (bubble < bubbles.length || echo < echoes.length) {
    const sent = bubbles[bubble]
    const ran = echoes[echo]
    if (ran && (!sent || sent.at === null || ran.at < sent.at)) {
      merged.push({ kind: "echo", echo: ran })
      echo += 1
    } else {
      merged.push({ kind: "sent", bubble: sent! })
      bubble += 1
    }
  }
  return merged
}

// The blocks with the bubbles and echoes among them: each where it went, before the first block
// recorded after it, or at the end, as one not sent yet, or gone after all the blocks.
export const withBubbles = (
  blocks: readonly ChatBlock[],
  bubbles: readonly SentBubble[],
  echoes: readonly Echo[] = noEchoes,
): readonly Placed[] => {
  const between = asides(bubbles, echoes)
  const placed: Placed[] = []
  let next = 0
  // Whether the next one went before a block recorded at `at`.
  const before = (at: number | null): boolean => {
    const aside = between[next]
    const went =
      aside === undefined ? null : aside.kind === "echo" ? aside.echo.at : aside.bubble.at
    return at !== null && went !== null && went < at
  }
  for (const block of blocks) {
    const at = blockAt(block)
    while (before(at)) placed.push(between[next++]!)
    placed.push({ kind: "block", block })
  }
  while (next < between.length) placed.push(between[next++]!)
  return placed
}
