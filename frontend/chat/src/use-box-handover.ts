import type { Conversation } from "@novadeck/core/conversation"
import type { Store } from "@novadeck/core/store"
import { useEffect, useRef } from "react"

// While a terminal shows as chat, its agent's box is no place to write: what comes to hold text
// there moves to the chat's box (`take`), once per text the box shows: the backend leaves what
// it can't read whole in the box, which the chat shows as it is. As the terminal shows again,
// what the chat's box holds goes to the agent's, where it can (`put`).
//
// The first take as the chat comes to show with nothing in its box is of words typed ahead, as
// the person typed on while the agent started: what they type in the chat meanwhile goes on
// from them (`ahead`), as one run of keys.
export const useBoxHandover = (
  conversation: Store<Conversation> | undefined,
  {
    take,
    put,
    draft,
  }: {
    readonly take: (ahead: boolean) => void
    readonly put: () => void
    // What the chat's box holds.
    readonly draft: string
  },
): void => {
  const moves = useRef({ take, put, draft })
  useEffect(() => {
    moves.current = { take, put, draft }
  })
  const shown = conversation !== undefined
  const wasShown = useRef(shown)
  useEffect(() => {
    if (wasShown.current && !shown) moves.current.put()
    wasShown.current = shown
  }, [shown])
  useEffect(() => {
    if (!conversation) return
    let tried: string | null = null
    let ahead = moves.current.draft === ""
    const look = (): void => {
      const box = conversation.getSnapshot().box
      const text = box === null || box.tail ? null : box.text
      if (text !== null && text !== tried) {
        moves.current.take(ahead)
        ahead = false
      }
      tried = text
    }
    look()
    return conversation.subscribe(look)
  }, [conversation])
}
