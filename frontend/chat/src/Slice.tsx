import type { ChatSlice } from "@novadeck/core/conversation"
import { hasControlCharacters } from "@novadeck/core/conversation/prompt-refusal"
import { sliceRunStyle } from "@novadeck/core/conversation/slice"
import { createContext, useContext, useEffect, useRef } from "react"

import { terminalKey } from "./passing"

// Where the keys of a slice that shows live go, in the terminal; none where it takes none.
export const SliceKeys = createContext<((keys: string) => void) | null>(null)

// The terminal's own rows, as they are drawn: as wide as its columns, so a narrower chat
// scrolls them. Plain for now; the look comes with the chat's redesign. `live`, a view or a
// dialog takes the keys while it shows, every one of them, as it stands where the box did; a
// menu's come from the box, which holds its text.
export const Slice = ({
  slice,
  live = false,
}: {
  readonly slice: ChatSlice
  readonly live?: boolean
}): React.JSX.Element => {
  const keys = useContext(SliceKeys)
  const element = useRef<HTMLPreElement>(null)
  const taking = live && keys !== null && slice.reason !== "menu"
  useEffect(() => {
    if (!taking) return
    const active = document.activeElement
    const chat = element.current?.closest(".chat")
    if (!active || active === document.body || chat?.contains(active))
      element.current?.focus({ preventScroll: true })
  }, [taking])
  return (
    <pre
      ref={element}
      className="chat-raw chat-slice nodrag nopan nowheel"
      tabIndex={0}
      aria-label="The terminal's own rows"
      style={{ width: `${slice.columns}ch`, maxWidth: "100%" }}
      onKeyDown={
        taking
          ? (event) => {
              // What is selected of it is the person's to copy.
              const selection = window.getSelection()
              const copying =
                (event.ctrlKey || event.metaKey) &&
                event.key === "c" &&
                selection?.isCollapsed === false &&
                element.current?.contains(selection.anchorNode)
              if (copying) return
              const pressed = terminalKey(event)
              if (pressed === undefined || event.nativeEvent.isComposing) return
              event.preventDefault()
              keys(pressed)
            }
          : undefined
      }
      onPaste={
        taking
          ? (event) => {
              // A view's field: what `/login` asks to have pasted, a line at most.
              const text = event.clipboardData.getData("text/plain").trim()
              event.preventDefault()
              if (text !== "" && text.length <= 1024 && !hasControlCharacters(text)) keys(text)
            }
          : undefined
      }
    >
      {slice.rows.map((row, at) => (
        // A row has no identity but its place on the screen.
        // eslint-disable-next-line react/no-array-index-key
        <div key={at}>
          {row.length === 0
            ? " "
            : row.map((run, part) => (
                // eslint-disable-next-line react/no-array-index-key
                <span key={part} style={sliceRunStyle(run)}>
                  {run.text}
                </span>
              ))}
        </div>
      ))}
    </pre>
  )
}
