import type { Conversation } from "@novadeck/core/conversation"
import type { Store } from "@novadeck/core/store"
import { useEffect, useRef } from "react"

// How long after the chat comes to show the agent's box may come to hold words typed ahead: an
// agent starting reads the keys typed meanwhile and draws its box within a few seconds.
export const aheadMs = 10_000

// While a terminal shows as chat, its agent's box is no place to write: what comes to hold text
// there moves to the chat's box (`take`), once per text the box shows: the backend leaves what
// it can't read whole in the box, which the chat shows as it is. As the terminal shows again,
// what the chat's box holds goes to the agent's, where it can (`put`).
//
// Words the box comes to hold soon after the chat comes to show with nothing in its own box were
// typed ahead, as the person typed on while the agent started: what they type in the chat
// meanwhile goes on from them (`ahead`), as one run of keys. That lasts until a take moves words
// (`take` answers whether it did), and no longer than `aheadMs`: words the box holds later are
// the agent's or the person's own of another time, as a prompt a Stop put back.
export const useBoxHandover = (
  conversation: Store<Conversation> | undefined,
  {
    take,
    put,
    draft,
  }: {
    readonly take: (ahead: boolean) => Promise<boolean> | void
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
    const shownAt = Date.now()
    const look = (): void => {
      const box = conversation.getSnapshot().box
      const text = box === null || box.tail ? null : box.text
      if (text !== null && text !== tried) {
        const taking = moves.current.take(ahead && Date.now() - shownAt <= aheadMs)
        void taking?.then((moved) => {
          if (moved) ahead = false
        })
      }
      tried = text
    }
    look()
    return conversation.subscribe(look)
  }, [conversation])
}
