import type { Conversation } from "@novadeck/core/conversation"
import type { Store } from "@novadeck/core/store"
import { useEffect, useRef } from "react"

// While a terminal shows as chat, its agent's box is no place to write: what comes to hold text
// there moves to the chat's box (`take`), once per text the box shows: the backend leaves what
// it can't read whole in the box, which the chat shows as it is. As the terminal shows again,
// what the chat's box holds goes to the agent's, where it can (`put`).
export const useBoxHandover = (
  conversation: Store<Conversation> | undefined,
  { take, put }: { readonly take: () => void; readonly put: () => void },
): void => {
  const moves = useRef({ take, put })
  useEffect(() => {
    moves.current = { take, put }
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
    const look = (): void => {
      const box = conversation.getSnapshot().box
      const text = box === null || box.tail ? null : box.text
      if (text !== null && text !== tried) moves.current.take()
      tried = text
    }
    look()
    return conversation.subscribe(look)
  }, [conversation])
}
