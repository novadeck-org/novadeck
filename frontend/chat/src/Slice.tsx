import type { ChatSlice } from "@novadeck/core/conversation"
import { hasControlCharacters } from "@novadeck/core/conversation/prompt-refusal"
import { sliceRunStyle } from "@novadeck/core/conversation/slice"
import { createContext, useContext, useEffect, useRef } from "react"

import { terminalKey } from "./passing"

// Where the keys of a slice that shows live go, in the terminal; none where it takes none.
export const SliceKeys = createContext<((keys: string) => void) | null>(null)

// The terminal's own rows, as they are drawn: as wide as its columns, so a narrower chat
// scrolls them. `live`, a view or a dialog takes the keys while it shows, every one of them, as it stands where the box did; a
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
  const comesByItself = slice.reason === "dialog"
  useEffect(() => {
    if (!taking) return
    const active = document.activeElement
    const chat = element.current?.closest(".chat")
    // A dialog comes by itself: wherever the person is stays theirs, or what they press next
    // would be an answer. A view is their own doing.
    if (comesByItself && active && active !== document.body) return
    if (!active || active === document.body || chat?.contains(active))
      element.current?.focus({ preventScroll: true })
  }, [taking, comesByItself])
  return (
    <pre
      ref={element}
      className="chat-slice nodrag nopan nowheel"
      tabIndex={0}
      aria-label="The terminal's own rows"
      style={{ "--chat-slice-columns": slice.columns } as React.CSSProperties}
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

// What a key on the title's line writes, for the pointer: a view's and a dialog's own keys.
const liveKeys = [
  { name: "Up", cap: "↑", keys: "\x1b[A" },
  { name: "Down", cap: "↓", keys: "\x1b[B" },
  { name: "Enter", cap: "⏎", keys: "\r" },
  { name: "Escape", cap: "esc", keys: "\x1b" },
] as const

const whats = { menu: "menu", view: "view", dialog: "dialog" } as const

// The terminal's own rows standing in the chat, live: a title that says whose they are, the keys
// for the pointer where they take keys, and `aside`, a word on the title's line.
export const LiveSlice = ({
  slice,
  agent,
  aside,
}: {
  readonly slice: ChatSlice
  // The agent's name, as the chat gives it.
  readonly agent: string
  readonly aside?: string | null
}): React.JSX.Element => {
  const keys = useContext(SliceKeys)
  return (
    <section
      className="chat-live"
      // The rows take the keys, but for a menu of the harness's, which the box passes them to.
      data-takes-keys={slice.reason !== "menu" || undefined}
      aria-label={`${agent}'s own ${whats[slice.reason]}`}
    >
      <div className="chat-live-title">
        <span>
          {agent}'s own {whats[slice.reason]} · live from its terminal
        </span>
        {aside && <span>{aside}</span>}
        {keys && slice.reason !== "menu" && (
          <span className="chat-live-keys">
            {liveKeys.map(({ name, cap, keys: pressed }) => (
              <button
                key={name}
                type="button"
                className="chat-key nodrag nopan"
                aria-label={name}
                tabIndex={-1}
                onClick={(event) => {
                  keys(pressed)
                  event.currentTarget
                    .closest(".chat-live")
                    ?.querySelector<HTMLElement>(".chat-slice")
                    ?.focus({ preventScroll: true })
                }}
              >
                {cap}
              </button>
            ))}
          </span>
        )}
      </div>
      <Slice slice={slice} live />
    </section>
  )
}
