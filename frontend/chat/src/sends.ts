import type { Attachment } from "./attachments"
import { valueOf, withValue, type ByTerminal } from "./by-terminal"
import type { ChatReply } from "./replies"

// Words on their way to a terminal's agent, from the chat's box:
// - `ref`: what names the prompt's receipt in the conversation (`Conversation.prompts`);
// - `draft`: the draft they were sent from, as typed, which goes back in the box should they
//   not go;
// - `text`: the words as sent, with the images' placeholders taken out, empty for a message of
//   images alone;
// - `images`: the images that go with them, in the order of their placeholders, ready on the
//   agent's machine, which go back in the box with the draft should they not go;
// - `at`: where each image stands in `text`, as the protocol has it (one per image);
// - `to`: the question they answer, for a reply, which goes at once and shows as its dialog's
//   answer; null for a prompt, which takes its turn in the terminal's queue;
// - `phase`: `queued` while a prompt before it hasn't reached the agent's record yet, or a
//   doorbell ring is under way;
//   `typing` while it goes into the agent's box; `sent` once it went, until its receipt says
//   whether the record has it; `settled` once the record has it, kept only for its words
//   until the conversation holds its item.
export type ChatSend = {
  readonly ref: string
  readonly draft: string
  readonly text: string
  readonly images: readonly Attachment[]
  readonly at: readonly number[]
  readonly to: ChatReply | null
  readonly phase: "queued" | "typing" | "sent" | "settled"
}

// The words on their way to each terminal's agent, oldest first, by session context and
// terminal id: taken out of the draft as they are sent. A prompt goes once the one before
// it reached the agent's record, so the chat never stacks prompts in the agent's own queue.
export type ChatSends = ByTerminal<readonly ChatSend[]>

export const noChatSends: ChatSends = {}

const none: readonly ChatSend[] = []

export const chatSendsOf = (sends: ChatSends, context: string, id: string): readonly ChatSend[] =>
  valueOf(sends, context, id) ?? none

export const setChatSends = (
  sends: ChatSends,
  context: string,
  id: string,
  list: readonly ChatSend[],
): ChatSends => withValue(sends, context, id, list.length > 0 ? list : undefined)

// The send `ref` names changed by `change`, or dropped where it gives null.
export const withSend = (
  sends: ChatSends,
  context: string,
  id: string,
  ref: string,
  change: (send: ChatSend) => ChatSend | null,
): ChatSends =>
  setChatSends(
    sends,
    context,
    id,
    chatSendsOf(sends, context, id).flatMap((send) => {
      if (send.ref !== ref) return [send]
      const next = change(send)
      return next ? [next] : []
    }),
  )

// The reply on its way to the terminal's agent, if one is.
export const chatReplySendOf = (sends: ChatSends, context: string, id: string): ChatSend | null =>
  chatSendsOf(sends, context, id).find((send) => send.to !== null) ?? null

// The images and draft of prompts the record never got, by ref, for as long as their line can be
// sent again or taken back to edit: kept for the page's life apart from the send, which ended
// with its receipt. The draft is the words with the images' placeholders, as the person wrote
// them. Whoever takes a line's images takes them out.
const kept = new Map<string, { readonly images: readonly Attachment[]; readonly draft: string }>()

export const keepSentImages = (ref: string, images: readonly Attachment[], draft: string): void => {
  if (images.length > 0) kept.set(ref, { images, draft })
}

// The images kept for a line, left kept.
export const keptImagesOf = (ref: string): readonly Attachment[] | undefined =>
  kept.get(ref)?.images

// The draft a line with kept images was sent from, left kept.
export const keptDraftOf = (ref: string): string | undefined => kept.get(ref)?.draft

// The kept image saved at `path`, if one is.
export const keptImageAt = (path: string): Attachment | undefined =>
  [...kept.values()].flatMap(({ images }) => images).find((image) => image.path === path)

// Takes a line's kept images out, to go on with them.
export const takeSentImages = (ref: string): readonly Attachment[] => {
  const images = kept.get(ref)?.images ?? []
  kept.delete(ref)
  return images
}
