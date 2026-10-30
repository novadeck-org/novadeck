import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react"

import { answering, menuKey, startCursor, type Cursor } from "./menu-keys"
import { Text } from "./sheet-parts"

// A sheet's numbered menu, as a terminal's prompt draws one: `❯` on the row the cursor is
// on, the number that presses it, the row's words and, under them, what it does where that
// says more. Keys are `menu-keys.ts`'s. A row for the person's own words becomes a box in
// place: it takes every key, Enter sends, Shift+Enter starts a line and Esc goes back to the
// rows, keeping the words.

export type Words = {
  readonly value: string
  readonly onChange: (text: string) => void
  readonly placeholder: string
  // The box's name, for a screen reader.
  readonly field: string
  readonly required: boolean
  // Why the words won't go; null where they will.
  readonly refused: string | null
  // What Enter does with them, as the hint under the box says it.
  readonly hint: string
}

export type MenuItem = {
  readonly key: string
  readonly label: string
  readonly effect: string | null
  // The agent's own pick.
  readonly pick?: boolean
  // Ticked or not, in a menu of several picks or for a switch.
  readonly check?: boolean
  // Picked or not, in a menu of one pick: the row the person chose shows it.
  readonly chosen?: boolean
  // Whether pressing the row must be armed first, as `hard` says for all of them.
  readonly arms?: boolean
  // More about the row, shown under the menu while the cursor is on it.
  readonly more?: ReactNode
  readonly words?: Words
  // A way out of the sheet, as to the item's terminal: it answers nothing, so it never arms,
  // ticks, nor sends on Enter.
  readonly away?: boolean
}

export type MenuHandle = {
  // Takes a key pressed outside the menu (on its row, the sheet's title): true where it was
  // the menu's, and focus is in the menu now.
  readonly key: (key: string) => boolean
  // Moves the cursor, and focus, to a row, pressing nothing.
  readonly go: (at: number) => void
}

// How long a sheet the Inbox moved on to takes no answer from the keyboard: a key pressed
// twice, or held, for the one before never answers the next.
const arrivalGuardMs = 400

// What a box may hold, as the runner limits a reply.
export const wordsLimit = 4096

export const Menu = ({
  label,
  items,
  multi = false,
  hard = false,
  busy,
  pressed,
  onPress,
  onWords,
  onSend,
  handle,
  arrived = false,
}: {
  readonly label: string
  readonly items: readonly MenuItem[]
  readonly multi?: boolean
  readonly hard?: boolean
  // An answer is on its way: nothing presses meanwhile.
  readonly busy: boolean
  // The row whose answer went.
  readonly pressed: number | null
  // A row pressed: answered at once, or ticked; a words row opens its box first.
  readonly onPress: (at: number) => void
  // Enter in a words row's box, in a menu of one choice.
  readonly onWords?: (at: number) => void
  // Enter, in a menu of several picks.
  readonly onSend?: () => void
  readonly handle?: Ref<MenuHandle>
  // Whether the Inbox moved on to this sheet from an answer: focus comes to its first row,
  // and for a moment no key answers.
  readonly arrived?: boolean
}): React.JSX.Element => {
  const [cursor, setCursor] = useState<Cursor>(startCursor)
  // The words row whose box has the keys.
  // A menu that is only a words row, and ways out, opens on its box.
  const [typing, setTyping] = useState<number | null>(
    items[0]?.words && items.slice(1).every((item) => item.away) ? 0 : null,
  )
  const rows = useRef<(HTMLElement | null)[]>([])
  const boxes = useRef<(HTMLTextAreaElement | null)[]>([])
  const focusAt = useRef<number | null>(null)
  const at = Math.min(cursor.at, Math.max(0, items.length - 1))
  // Opening a box for words sends nothing, so only an answer arms; the words arm as they go.
  const shape = {
    count: items.length,
    multi,
    arms: (index: number) =>
      (hard && !items[index]?.words && !items[index]?.away) || Boolean(items[index]?.arms),
    leaves: (index: number) => Boolean(items[index]?.away),
  }
  const hints = useId()

  // Until when keys don't answer: set as it arrives.
  const guard = useRef(0)
  useEffect(() => {
    if (!arrived) return
    guard.current = Date.now() + arrivalGuardMs
    // The sheet before had focus, and went: it comes here, so the keyboard keeps its place.
    const active = document.activeElement
    if (!active || active === document.body || active.closest(".inbox-sheet"))
      (rows.current[0] ?? boxes.current[0])?.focus()
  }, [arrived])
  // Whether a key is to be let through: no repeat answers, nor anything as the sheet arrives.
  const held = (key: string, repeat: boolean): boolean =>
    answering(key) && (repeat || Date.now() < guard.current)

  // Focus follows the cursor once it has moved there.
  useLayoutEffect(() => {
    if (focusAt.current === null) return
    const target =
      typing === focusAt.current ? boxes.current[typing] : rows.current[focusAt.current]
    focusAt.current = null
    target?.focus()
  })

  const press = (index: number): void => {
    if (busy) return
    const item = items[index]
    if (!item) return
    if (item.words) {
      // Ticking it opens its box; unticking leaves the words out, and the box shut.
      if (multi) onPress(index)
      if (!multi || !item.check) {
        setTyping(index)
        focusAt.current = index
      }
      return
    }
    onPress(index)
  }

  const apply = (key: string): boolean => {
    const result = menuKey(shape, { ...cursor, at }, key)
    if (!result) return false
    setCursor(result.cursor)
    focusAt.current = result.cursor.at
    if (result.press === "send") onSend?.()
    else if (result.press !== null) press(result.press)
    return true
  }

  useImperativeHandle(handle, () => ({
    key: (key) => (held(key, false) ? true : apply(key)),
    go: (index) => {
      setCursor({ at: index, armed: null })
      focusAt.current = index
    },
  }))

  const sendWords = (index: number, words: Words): void => {
    if (busy || words.refused) return
    if (words.required && words.value.trim() === "") return
    if (words.value.length > wordsLimit) return
    if (multi) return onSend?.()
    // Hard to undo: the first Enter arms, the second sends.
    if (hard && cursor.armed !== index) return setCursor({ at: index, armed: index })
    setCursor({ at: index, armed: null })
    onWords?.(index)
  }

  return (
    <div
      className="console-menu"
      role="menu"
      aria-label={label}
      aria-busy={busy || undefined}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return
        if (event.ctrlKey || event.metaKey || event.altKey) return
        if (event.target instanceof HTMLTextAreaElement) return
        // An option's details are read, scrolled and followed, not answered from.
        if (event.target instanceof Element && event.target.closest(".console-more")) return
        if (held(event.key, event.repeat)) return event.preventDefault()
        if (apply(event.key)) event.preventDefault()
      }}
    >
      {items.map((item, index) => {
        const on = index === at
        const armed = cursor.armed === index
        const role = item.away
          ? "menuitem"
          : multi || item.check !== undefined
            ? "menuitemcheckbox"
            : item.chosen !== undefined
              ? "menuitemradio"
              : "menuitem"
        const number = item.check === undefined ? String(index + 1) : item.check ? "[x]" : "[ ]"
        const words = item.words
        const open = words && typing === index
        const common = {
          "data-on": on,
          "data-pressed": pressed === index || undefined,
          "data-armed": armed || undefined,
        }
        if (open && words)
          return (
            <div
              key={item.key}
              className="console-option console-own"
              role="group"
              aria-label={item.label}
              {...common}
            >
              <span className="console-cur" aria-hidden="true">
                {on ? "❯" : ""}
              </span>
              <span className="console-n" aria-hidden="true">
                {number}
              </span>
              <textarea
                ref={(element) => {
                  boxes.current[index] = element
                }}
                className="console-own-box"
                rows={1}
                value={words.value}
                placeholder={words.placeholder}
                aria-label={words.field}
                aria-required={words.required || undefined}
                aria-invalid={words.value.length > wordsLimit || undefined}
                aria-describedby={`${hints}-${index}`}
                // Read-only, not disabled, while a reply is on its way or has not been
                // delivered: the words stay there to select and copy.
                readOnly={busy}
                data-cancels=""
                onFocus={() => {
                  setTyping(index)
                  if (cursor.at !== index) setCursor({ at: index, armed: null })
                }}
                onChange={(event) => {
                  const box = event.target
                  box.style.height = "auto"
                  box.style.height = `${Math.min(box.scrollHeight, 140)}px`
                  if (armed) setCursor({ at: index, armed: null })
                  words.onChange(box.value)
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === "Escape") {
                    // Back to the rows, keeping the words.
                    event.preventDefault()
                    event.stopPropagation()
                    setTyping(null)
                    focusAt.current = index
                    setCursor({ at: index, armed: null })
                    return
                  }
                  if (event.key !== "Enter" || event.shiftKey) return
                  if (event.ctrlKey || event.metaKey || event.altKey) return
                  event.preventDefault()
                  if (held(event.key, event.repeat)) return
                  sendWords(index, words)
                }}
              />
              <span
                id={`${hints}-${index}`}
                className="console-own-hint"
                role={words.refused ? "alert" : undefined}
              >
                {words.refused ??
                  (words.value.length > wordsLimit
                    ? `${(words.value.length - wordsLimit).toLocaleString("en-US")} over the 4,096 character limit. Shorten it to send.`
                    : armed
                      ? "↵ again to send it"
                      : words.required && words.value.trim() === ""
                        ? "type your answer · Esc back to the options"
                        : `↵ ${words.hint} · Esc back to the options`)}
              </span>
            </div>
          )
        return (
          <button
            key={item.key}
            ref={(element) => {
              rows.current[index] = element
            }}
            type="button"
            className="console-option"
            role={role}
            aria-checked={
              role === "menuitemcheckbox"
                ? Boolean(item.check)
                : role === "menuitemradio"
                  ? item.chosen
                  : undefined
            }
            data-chosen={item.chosen || undefined}
            aria-disabled={busy || undefined}
            tabIndex={on ? 0 : -1}
            onFocus={() => {
              if (!on) setCursor({ at: index, armed: null })
            }}
            onClick={() => {
              // A double-click's second click, landing as the sheet moves on, isn't for this item.
              if (Date.now() < guard.current) return
              const result = menuKey(shape, { ...cursor, at: index }, String(index + 1))
              if (!result) return press(index)
              setCursor(result.cursor)
              if (result.press !== null && result.press !== "send") press(result.press)
            }}
            {...common}
          >
            <span className="console-cur" aria-hidden="true">
              {on ? "❯" : ""}
            </span>
            <span className="console-n" aria-hidden="true">
              {number}
            </span>
            <span className="console-t">
              {words && words.value.trim() !== "" ? (
                <q className="console-said">{words.value}</q>
              ) : (
                <Text text={item.label} />
              )}
              {item.pick && <span className="console-pick"> its pick</span>}
              {item.chosen && (
                <span className="console-chosen" aria-hidden="true">
                  ✓ your pick
                </span>
              )}
              {armed && <span className="console-confirm">↵ again to send it</span>}
            </span>
            {item.effect && (
              <span className="console-s">
                <Text text={item.effect} />
              </span>
            )}
          </button>
        )
      })}
      {/* The cursor's row's details, under the rows, so that no row moves as the cursor does. */}
      {items[at]?.more && (
        <div className="console-more" role="note" aria-label={`More about ${at + 1}`}>
          <span className="console-more-of" aria-hidden="true">
            More about {at + 1}
          </span>
          {items[at]?.more}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {cursor.armed !== null ? "Hard to undo. Press again to send it." : ""}
      </span>
    </div>
  )
}
