import { useLayoutEffect, useRef, type RefObject } from "react"

// As a terminal's chat comes over its screen, as when the person starts an agent there, the
// chat's box takes the keyboard focus the terminal had: the screen goes inert beneath the chat,
// which would leave focus nowhere and the person clicking for the box. Focus the browser has
// already dropped counts as the terminal's while it is the selected one on screen; focus
// anywhere else, as in another terminal or a dialog, stays where it is. A chat there from the
// start leaves focus to the keyboard's own requests.
export const useChatTakesFocus = (
  host: RefObject<HTMLElement | null>,
  shown: boolean,
  selected: boolean,
): void => {
  const was = useRef(shown)
  useLayoutEffect(() => {
    const came = shown && !was.current
    was.current = shown
    const within = host.current
    if (!came || !within) return
    const box = within.querySelector<HTMLElement>(".chat-pane .chat-input")
    const at = document.activeElement
    const dropped = at === null || at === document.body
    if (box && (dropped ? selected : within.contains(at))) box.focus({ preventScroll: true })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Only as the chat comes.
  }, [shown])
}
