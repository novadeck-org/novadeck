import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"

// What takes its own keys in a chat: the cards of what waits on the person, and the agent's own
// rows while they take the keys.
const ownKeys = ".chat-requests, .chat-live"
// What a click leaves focus on for good: a control, or a field of its own.
const controls =
  'button, a[href], input, textarea, select, summary, [role="button"], [contenteditable]:not([contenteditable="false"])'
// Where a copy belongs to a field, or to what takes its own keys.
const typedIn = `input, textarea, select, [contenteditable]:not([contenteditable="false"]), ${ownKeys}`

// The box is where typing goes in a chat, so focus comes back there from what the person does
// elsewhere in it: a mouse click on its words or around them (the log takes focus to scroll by
// keys, a code block to scroll sideways), and a copy of what they selected once it is copied
// (focus moved any sooner would take the selection with it). A click on a control keeps the
// focus it took, a selection stays to be copied, and nothing comes back while `off`, as while
// the agent's own rows take the keys. A key typed elsewhere reaches the box already, as the
// workspace types it into the selected terminal's input.
export const useBoxReturn = (
  chat: RefObject<HTMLElement | null>,
  off: boolean,
  focusBox: () => void,
): {
  readonly onPointerDown: (event: React.PointerEvent) => void
  readonly onClick: (event: React.MouseEvent) => void
} => {
  const pointer = useRef("")
  const latest = useRef({ off, focusBox })
  useLayoutEffect(() => {
    latest.current = { off, focusBox }
  })
  useEffect(() => {
    const copied = (): void => {
      const within = chat.current
      const selection = window.getSelection()
      if (latest.current.off || !within || !selection || selection.isCollapsed) return
      if (!selection.anchorNode || !within.contains(selection.anchorNode)) return
      const active = document.activeElement
      if (active instanceof Element && active.closest(typedIn)) return
      // After the copy has read the selection.
      setTimeout(() => latest.current.focusBox())
    }
    document.addEventListener("copy", copied)
    return () => document.removeEventListener("copy", copied)
  }, [chat])
  return {
    onPointerDown: (event) => {
      pointer.current = event.pointerType
    },
    onClick: (event) => {
      // Only a mouse's single click: a tap would raise a phone's keyboard, and a double or
      // triple click selects.
      if (latest.current.off || pointer.current !== "mouse" || event.detail !== 1) return
      const target = event.target
      if (!(target instanceof Element) || target.closest(`${controls}, ${ownKeys}`)) return
      requestAnimationFrame(() => {
        const within = chat.current
        const now = document.activeElement
        if (latest.current.off || !within || window.getSelection()?.isCollapsed === false) return
        const landed =
          !now ||
          now === document.body ||
          (within.contains(now) && now.matches(".chat-scroll, .chat-scroll pre"))
        if (landed) latest.current.focusBox()
      })
    },
  }
}
