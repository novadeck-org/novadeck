import { useLayoutEffect, useRef, type RefObject } from "react"

// As a terminal's chat comes over its screen, as when the person starts an agent there, the
// chat's box takes the keyboard focus the terminal had: the screen goes inert beneath the chat,
// which would leave focus nowhere and the person clicking for the box. Focus the browser has
// already dropped counts as the terminal's while it is the selected one on screen; focus
// anywhere else, as in another terminal or a dialog, stays where it is. A chat there from the
// start leaves focus to the keyboard's own requests. A chat that builds in its turn (see
// ./chat-turn) has no box yet as it comes: focus goes to it once it's there, as things stand
// then, unless that takes longer than `boxWaitMs`.
// How long a chat coming over its screen may take to build its box for the box to take focus.
export const boxWaitMs = 1000

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
    const focus = (box: HTMLElement): void => {
      const at = document.activeElement
      const dropped = at === null || at === document.body
      if (dropped ? selected : within.contains(at)) box.focus({ preventScroll: true })
    }
    const find = (): HTMLElement | null =>
      within.querySelector<HTMLElement>(".chat-pane .chat-input")
    const box = find()
    if (box) return focus(box)
    if (typeof MutationObserver !== "function") return
    const watch = new MutationObserver(() => {
      const built = find()
      if (!built) return
      stop()
      focus(built)
    })
    const late = setTimeout(() => stop(), boxWaitMs)
    const stop = (): void => {
      watch.disconnect()
      clearTimeout(late)
    }
    watch.observe(within, { childList: true, subtree: true })
    return stop
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Only as the chat comes.
  }, [shown])
}
