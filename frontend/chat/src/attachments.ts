import { valueOf, withValue, type ByTerminal } from "./by-terminal"

// The most images one message carries.
export const maxAttachments = 8

// An image the person pasted into a terminal's chat, to go with their next message:
// - `id`: what names it while it is here;
// - `name`: what it is called, for its label;
// - `preview`: an object URL of the pasted bytes, for its thumbnail;
// - `state`: `uploading` while it is being saved on the agent's machine, `ready` with its
//   `path` there once it is, `failed` with `error` (the reason, in words) if it couldn't be.
export type Attachment = {
  readonly id: string
  readonly name: string
  readonly preview: string
  readonly state: "uploading" | "ready" | "failed"
  readonly path: string | null
  readonly error: string | null
}

// The images waiting for each terminal's next message, by session context and terminal id,
// oldest first. They are part of the draft: an empty list is not kept.
export type ChatAttachments = ByTerminal<readonly Attachment[]>

export const noChatAttachments: ChatAttachments = {}

const none: readonly Attachment[] = []

export const chatAttachmentsOf = (
  attachments: ChatAttachments,
  context: string,
  id: string,
): readonly Attachment[] => valueOf(attachments, context, id) ?? none

export const setChatAttachments = (
  attachments: ChatAttachments,
  context: string,
  id: string,
  list: readonly Attachment[],
): ChatAttachments => withValue(attachments, context, id, list.length > 0 ? list : undefined)

// The attachment `id` names changed by `change`, or dropped where it gives null; the same
// attachments where none is named.
export const withAttachment = (
  attachments: ChatAttachments,
  context: string,
  terminalId: string,
  id: string,
  change: (attachment: Attachment) => Attachment | null,
): ChatAttachments => {
  const list = chatAttachmentsOf(attachments, context, terminalId)
  if (!list.some((each) => each.id === id)) return attachments
  return setChatAttachments(
    attachments,
    context,
    terminalId,
    list.flatMap((each) => {
      if (each.id !== id) return [each]
      const next = change(each)
      return next ? [next] : []
    }),
  )
}

// Why the images can't go with a message yet, or null where they can: one is still being
// saved, or one couldn't be and is for the person to take off.
export const attachmentsHold = (list: readonly Attachment[]): string | null => {
  if (list.some((each) => each.state === "uploading"))
    return "An image is still uploading. Send again once it has."
  if (list.some((each) => each.state === "failed"))
    return "An image didn't upload. Remove it to send the rest."
  return null
}

// What the runner takes of a pasted image.
export const imageTypes: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

// Lets go of the thumbnails' object URLs.
export const releaseImages = (images: readonly Attachment[]): void => {
  if (typeof URL.revokeObjectURL !== "function") return
  for (const image of images) if (image.preview) URL.revokeObjectURL(image.preview)
}

// The images of terminals `after` no longer holds: those of a terminal that closed.
export const droppedImages = (
  before: ChatAttachments,
  after: ChatAttachments,
): readonly Attachment[] =>
  Object.entries(before).flatMap(([context, ids]) =>
    Object.entries(ids).flatMap(([id, list]) =>
      chatAttachmentsOf(after, context, id).length === 0 ? list : [],
    ),
  )

// Images put back in a box that holds `current`, ahead of them, and no more than a message
// takes: `kept` is the box's new list, `over` what the box has no room for, which comes from
// the end.
export const withBack = (
  back: readonly Attachment[],
  current: readonly Attachment[],
): { readonly kept: readonly Attachment[]; readonly over: readonly Attachment[] } => {
  const all = [...back, ...current]
  return { kept: all.slice(0, maxAttachments), over: all.slice(maxAttachments) }
}

// The label for a new image among those held: its own name, numbered where another has it.
export const labelFor = (name: string, held: readonly string[]): string => {
  if (!held.includes(name)) return name
  let n = 2
  while (held.includes(`${name} ${n}`)) n += 1
  return `${name} ${n}`
}
