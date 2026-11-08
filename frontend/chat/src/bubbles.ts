import type { ChatPrompt } from "@novadeck/core/conversation"
import type { ChatBlock } from "@novadeck/core/conversation/turns"

import type { Attachment } from "./attachments"
import type { ChatSend } from "./sends"

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
  const textOf = (prompt: ChatPrompt) => prompt.text ?? local.get(prompt.ref)?.text
  const fromReceipts = prompts.flatMap((prompt): SentBubble[] => {
    const text = textOf(prompt)
    if (text === undefined) return []
    const { ref, sentAt: at } = prompt
    const images = local.get(ref)?.images ?? noImages
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
      text: send.text,
      images: send.images,
      state: send.phase === "queued" ? "queued" : "sending",
      at: null,
    }))
  return [...fromReceipts, ...ownLeft]
}

// When a block was recorded, where its harness said: tool runs and notes take none.
const blockAt = (block: ChatBlock): number | null =>
  block.kind === "user" || block.kind === "assistant" || block.kind === "agent" ? block.at : null

// The blocks with the bubbles among them: each where it was sent, before the first block
// recorded after it, or at the end, as one not sent yet, or sent after all the blocks.
export const withBubbles = (
  blocks: readonly ChatBlock[],
  bubbles: readonly SentBubble[],
): readonly (
  | { readonly kind: "block"; readonly block: ChatBlock }
  | { readonly kind: "sent"; readonly bubble: SentBubble }
)[] => {
  const placed: (
    | { readonly kind: "block"; readonly block: ChatBlock }
    | { readonly kind: "sent"; readonly bubble: SentBubble }
  )[] = []
  let next = 0
  // Whether the next bubble was sent before a block recorded at `at`.
  const before = (at: number | null): boolean => {
    const sent = bubbles[next]?.at
    return at !== null && sent !== undefined && sent !== null && sent < at
  }
  for (const block of blocks) {
    const at = blockAt(block)
    while (before(at)) placed.push({ kind: "sent", bubble: bubbles[next++]! })
    placed.push({ kind: "block", block })
  }
  while (next < bubbles.length) placed.push({ kind: "sent", bubble: bubbles[next++]! })
  return placed
}
