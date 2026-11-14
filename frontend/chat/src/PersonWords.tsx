import type { ChatImage } from "@novadeck/core/conversation"
import { MentionedText } from "@novadeck/toolkit/Mentioned"
import { mentionAt, type Mention } from "@novadeck/toolkit/mentions"

import { TimeFact } from "./Fact"
import { Mark } from "./Mark"
import type { MarkPhase } from "./mark-phase"
import { RecordedImages } from "./Thumbs"

export const Shortened = (): React.JSX.Element => (
  <p className="chat-shortened">Shortened here; the rest isn't carried over.</p>
)

/**
 * The person's words as the chat draws its prompt: the mark in the gutter, the images they sent,
 * the words in bold and their time. The Inbox's sheet draws the person's last words with it too,
 * so it needs nothing from the chat around it: its classes are chat.css's (`.chat-inline` holds
 * them outside a chat), its thumbnails show their names where no chat gives their pictures.
 * - `turn`: the item that starts a turn, which the chat's held prompt follows; absent outside the
 *   log.
 * - `phase`: the window's phase, on the prompt that started the latest turn.
 */
export const PersonWords = ({
  id,
  text,
  at,
  images,
  truncated = false,
  turn,
  phase,
  mention,
}: {
  readonly id: string
  readonly text: string
  readonly at: number | null
  readonly images?: readonly ChatImage[] | undefined
  readonly truncated?: boolean
  readonly turn?: string | undefined
  readonly phase?: MarkPhase | undefined
  readonly mention?: Mention | undefined
}): React.JSX.Element => (
  <article className="chat-message" data-role="user" data-turn={turn} aria-label="You">
    <Mark phase={phase} />
    {images && images.length > 0 && <RecordedImages item={id} images={images} text={text} />}
    <p className="chat-text">
      <MentionedText text={text} mention={mentionAt(mention, at)} />
    </p>
    {truncated && <Shortened />}
    <TimeFact at={at} />
  </article>
)
