import type { Conversation } from "@novadeck/core/conversation"
import type { Store } from "@novadeck/core/store"
import { usePanePicture, useStandInPicture, type PanePicture } from "@novadeck/items/pane-pictures"
import { usePaneTurn } from "@novadeck/items/pane-turns"
import { Shown, useShown } from "@novadeck/toolkit/shown"
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react"

// A chat builds in its turn, as companion panes do (items' pane-turns.ts): a view that shows
// many windows at once (Grid or Canvas opening, a pan) builds their chats one a frame, after
// the frame that showed the windows, the selected terminal's first. Until its first turn it
// stands in as a picture of itself from the last time this view showed it, where its
// conversation hasn't changed since (items' pane-pictures.ts), else as its terminal's name.
// Built, it comes back into sight as it was (chat's held.ts), and draws what came meanwhile
// in its turn.

// What a picture of a chat shows of its conversation as it stands, in a word that changes as
// that does, so a picture of it shows only while nothing new came: its items, what waits on
// the person, the agent's box and what its harness shows over it, the prompts on their way and
// what the doorbell holds.
export const chatMark = ({
  session,
  loaded,
  items,
  requests,
  box,
  slice,
  prompts,
  doorbell,
}: Conversation): string => {
  const last = items.at(-1)
  return [
    session ?? "",
    loaded,
    items.length,
    last?.id ?? "",
    last?.text.length ?? 0,
    requests.map((request) => `${request.id}:${request.answered}`).join(","),
    box?.text ?? "",
    slice === null ? "" : JSON.stringify(slice),
    prompts.map((prompt) => `${prompt.ref}:${prompt.state}`).join(","),
    doorbell.waiting.length,
    doorbell.delivered.length,
    doorbell.ringing,
  ].join("\n")
}

export const ChatTurn = ({
  first,
  name,
  conversation,
  picturedAs,
  drawn,
  atOnce,
  children,
}: {
  // Its terminal is the selected one: its chat takes its turn ahead of the others.
  readonly first: boolean
  // What else it draws, as the app keeps it (the draft, the words on their way, the reply,
  // the images), in a word that changes as that does: a picture shows only while that holds too.
  readonly drawn: string
  // It builds at once rather than in a turn: it came over a screen already in sight, as an
  // agent starting there, where what's typed must reach its box at once. It still waits its
  // turn coming back into sight.
  readonly atOnce: boolean
  // Its terminal's name, which stands in for it without a picture.
  readonly name: string
  readonly conversation: Store<Conversation>
  // What its pictures are kept by: its terminal in this view, as each view lays it out.
  readonly picturedAs: string
  readonly children: ReactNode
}): React.JSX.Element => {
  const turn = usePaneTurn(first, true, false)
  const inSight = useShown()
  const [now] = useState(atOnce)
  // Built at once, it's laid out until its first turn too.
  const built = turn.built || now
  const waiting = turn.built ? turn.waiting : !now
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const app = useRef(drawn)
  useLayoutEffect(() => {
    app.current = drawn
  })
  const mark = useCallback(
    () => `${chatMark(conversation.getSnapshot())}\n${app.current}`,
    [conversation],
  )
  const picture = usePanePicture(element, inSight && built && !waiting, picturedAs, mark)
  return (
    <div ref={setElement} className="chat-turn" data-waiting={!built || undefined}>
      {built && <Shown value={inSight && !waiting}>{children}</Shown>}
      {!built && <ChatStandIn name={name} picture={picture} />}
    </div>
  )
}

// What stands in for a chat until its first turn: its picture, where there is one at its
// size, else its terminal's name.
const ChatStandIn = ({
  name,
  picture,
}: {
  readonly name: string
  readonly picture: () => PanePicture | undefined
}): React.JSX.Element => {
  const element = useStandInPicture<HTMLDivElement>(picture)
  return (
    // A progress bar of no value, as something loading: no live region, which would speak
    // up for each chat a pan brings back.
    <div
      ref={element}
      className="pane-stand-in chat-stand-in"
      role="progressbar"
      aria-label={`Opening the chat of ${name}`}
    >
      <span className="pane-stand-in-name">{name}</span>
    </div>
  )
}
