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

import { Hint } from "./Hint"
import { answering, menuKey, pressRow, startCursor, type Cursor } from "./menu-keys"
import { isTyping } from "./use-menu"

// A request's numbered menu, as the next lines of the terminal: a number and the words of each
// row, a dim line under them where the row says more, and a thin bar on the row the person is on.
// Keys are `menu-keys.ts`'s, and the bar follows the mouse as it does the arrows, so what is lit
// is what Enter takes. A row that takes the person's own words opens a box under the rows: Enter
// sends from it, Shift+Enter starts a line and Esc goes back to the rows, keeping the words.
// Focus stays where it is as a menu appears, unless the host says the person arrived here from
// an answer (`arrived`): a menu that took it would take what they were typing for an answer.

export type Words = {
  readonly value: string
  readonly onChange: (text: string) => void
  readonly placeholder: string
  // The box's name, for a screen reader.
  readonly field: string
  readonly required: boolean
  // Why the words won't go, as a hint says it; null where they will.
  readonly refused: string | null
  // What Enter does with them, as the hint under the box says it.
  readonly hint: string
  // The most characters the way the words go takes (UTF-16 code units, as the protocol counts).
  readonly limit: number
  // The words go into a field of the agent's that takes one line: Shift+Enter starts none.
  readonly oneLine?: boolean
}

export type MenuItem = {
  readonly key: string
  readonly label: ReactNode
  // The label's own words that name its scope, on a line under it.
  readonly scope?: ReactNode
  // What follows that the label's words don't say, on a dim line under them.
  readonly effect?: ReactNode
  // The agent's own pick.
  readonly pick?: boolean
  // Ticked or not, in a menu of several picks or for a switch.
  readonly check?: boolean
  // Picked or not, in a menu of one pick: the row the person chose says so.
  readonly chosen?: boolean
  // Whether pressing the row must be armed first, as `hard` says for all of them.
  readonly arms?: boolean
  // More about the row, shown under the menu while the cursor is on it.
  readonly more?: ReactNode
  readonly words?: Words
  // A way out, as to the row's terminal: it answers nothing, so it never arms, ticks, nor
  // sends on Enter.
  readonly away?: boolean
}

export type MenuHandle = {
  // Takes a key pressed outside the menu (on the host's own row or title): true where it was
  // the menu's, and focus is in the menu now.
  readonly key: (key: string) => boolean
  // Moves the cursor, and focus, to a row, pressing nothing.
  readonly go: (at: number) => void
}

// The most characters of the person's words a request's answer takes (`requestAnswer`'s text).
export const answerWordsLimit = 16_384

// How long a menu the host moved on to takes no answer from the keyboard: a key pressed twice,
// or held, for the one before never answers the next.
const arrivalGuardMs = 400

// Whether a box's words may go as they are.
const ready = (given: Words): boolean =>
  !given.refused &&
  !(given.required && given.value.trim() === "") &&
  given.value.length <= given.limit

const overLimit = (words: Words): string =>
  `${(words.value.length - words.limit).toLocaleString("en-US")} over the ${words.limit.toLocaleString("en-US")} character limit. Shorten it to send.`

export const Menu = ({
  label,
  items,
  multi = false,
  hard = false,
  busy,
  pressed = null,
  onPress,
  onWords,
  onSend,
  onOpen,
  handle,
  arrived = false,
  area,
  opensBox = false,
}: {
  // The menu's name, for a screen reader.
  readonly label: string
  readonly items: readonly MenuItem[]
  readonly multi?: boolean
  // Every answer is hard to take back: each is armed first.
  readonly hard?: boolean
  // An answer is on its way: nothing presses meanwhile.
  readonly busy: boolean
  // The row whose answer went.
  readonly pressed?: number | null
  // A row pressed: answered at once, or ticked; a words row opens its box first.
  readonly onPress: (at: number) => void
  // Enter in a words row's box, in a menu of one choice.
  readonly onWords?: (at: number) => void
  // Enter, in a menu of several picks.
  readonly onSend?: () => void
  // A words row's box opened.
  readonly onOpen?: (at: number) => void
  readonly handle?: Ref<MenuHandle>
  // The host moved on to this menu from an answer: focus comes to its first row, and for a
  // moment no key answers.
  readonly arrived?: boolean
  // The part of the page the menu before had, whose focus it may take as it arrives.
  readonly area?: (menu: Element) => Element | null
  // A menu that is only a words row, and ways out, opens on its box (the Inbox's reply to an
  // ask that takes only words).
  readonly opensBox?: boolean
}): React.JSX.Element => {
  const [cursor, setCursor] = useState<Cursor>(startCursor)
  // The words row whose box is open, by its key: a menu read again keeps it open only while the
  // row is still there.
  const [typing, setTyping] = useState<string | null>(() =>
    opensBox && items[0]?.words && items.slice(1).every((item) => item.away) ? items[0].key : null,
  )
  const menu = useRef<HTMLDivElement>(null)
  const rows = useRef<(HTMLElement | null)[]>([])
  const box = useRef<HTMLTextAreaElement>(null)
  // Where focus goes once the cursor has moved: a row, or the open box.
  const focusTo = useRef<number | "box" | null>(null)
  const at = Math.min(cursor.at, Math.max(0, items.length - 1))
  const open = items.findIndex((item) => item.words !== undefined && item.key === typing)
  const writing = open >= 0 ? items[open] : undefined
  const words = writing?.words
  // Opening a box for words sends nothing, so only an answer arms; the words arm as they go.
  const arms = (index: number): boolean => {
    const item = items[index]
    return Boolean(item && !item.words && !item.away && (hard || item.arms))
  }
  const shape = {
    count: items.length,
    multi,
    arms,
    leaves: (index: number) => Boolean(items[index]?.away),
  }
  const ids = useId()

  // Until when keys don't answer: set as it arrives. Where it may take focus from is the host's
  // at the time.
  const guard = useRef(0)
  const areaNow = useRef(area)
  useEffect(() => {
    areaNow.current = area
  })
  useEffect(() => {
    if (!arrived) return
    guard.current = Date.now() + arrivalGuardMs
    // What had focus went with the menu before: it comes here, so the keyboard keeps its place.
    const active = document.activeElement
    const before = menu.current && areaNow.current?.(menu.current)
    // A menu that opened on its box takes the person's words there.
    if (!active || active === document.body || before?.contains(active))
      (box.current ?? rows.current[0])?.focus()
  }, [arrived])
  // Whether a key is to be held back: no repeat answers, nor anything as the menu arrives.
  const held = (key: string, repeat: boolean): boolean =>
    answering(key) && (repeat || Date.now() < guard.current)

  // Focus follows the cursor once it has moved there.
  useLayoutEffect(() => {
    const to = focusTo.current
    if (to === null) return
    focusTo.current = null
    if (to === "box") box.current?.focus()
    else rows.current[to]?.focus()
  })

  const press = (index: number): void => {
    if (busy) return
    const item = items[index]
    if (!item) return
    if (item.words) {
      // Ticking it opens its box; unticking leaves the words out, and the box shut. In a menu of
      // one choice, pressing it again shuts its box, keeping the words.
      if (multi) onPress(index)
      if (!multi && typing === item.key) {
        setTyping(null)
        focusTo.current = index
      } else if (!multi || !item.check) {
        setTyping(item.key)
        focusTo.current = "box"
        onOpen?.(index)
      } else if (typing === item.key) setTyping(null)
      return
    }
    onPress(index)
  }

  const apply = (key: string, wrap = true): boolean => {
    const result = menuKey(shape, { ...cursor, at }, key, wrap)
    if (!result) return false
    setCursor(result.cursor)
    focusTo.current = result.cursor.at
    if (result.press === "send") onSend?.()
    else if (result.press !== null) press(result.press)
    return true
  }

  useImperativeHandle(handle, () => ({
    key: (key) => (held(key, false) ? true : apply(key, false)),
    go: (index) => {
      setCursor({ at: index, armed: null })
      // To a words row whose box is open: into its words.
      const item = items[index]
      focusTo.current = item?.words && item.key === typing ? "box" : index
    },
  }))

  const sendWords = (): void => {
    if (busy || !words || !ready(words)) return
    if (multi) return onSend?.()
    // Hard to undo: the first Enter arms, the second sends.
    if ((hard || writing?.arms) && cursor.armed !== open)
      return setCursor({ at: open, armed: open })
    setCursor({ at: open, armed: null })
    onWords?.(open)
  }
  const back = (): void => {
    setTyping(null)
    setCursor({ at: open, armed: null })
    focusTo.current = open
  }

  const armedWords = writing !== undefined && cursor.armed === open
  // Why the words won't go, said as it comes; else what the keys do with them.
  const warning =
    words && (words.refused ?? (words.value.length > words.limit ? overLimit(words) : ""))
  const keys =
    words && !warning
      ? armedWords
        ? "↵ again to send it"
        : words.required && words.value.trim() === ""
          ? "type your answer · Esc back to the options"
          : `↵ ${words.hint} · Esc back to the options`
      : ""

  return (
    <div ref={menu} className="request-menu">
      <div
        className="request-options"
        role="menu"
        aria-label={label}
        aria-busy={busy || undefined}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.nativeEvent.isComposing) return
          if (event.ctrlKey || event.metaKey || event.altKey) return
          if (isTyping(event.target)) return
          if (held(event.key, event.repeat)) return event.preventDefault()
          if (apply(event.key)) event.preventDefault()
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return
          const row = event.target.closest<HTMLElement>(".request-option")
          const index = row ? rows.current.indexOf(row) : -1
          // An armed row keeps the cursor: the mouse passing over another never disarms it.
          if (index < 0 || index === at || cursor.armed !== null) return
          setCursor({ at: index, armed: null })
          // Focus goes along from anything in the menu but the person's words, which would
          // land on a row instead.
          const active = document.activeElement
          if (active && menu.current?.contains(active) && !isTyping(active))
            row?.focus({ preventScroll: true })
        }}
      >
        {items.map((item, index) => {
          const on = index === at
          const armed = cursor.armed === index && !item.words
          const role = item.away
            ? "menuitem"
            : multi || item.check !== undefined
              ? "menuitemcheckbox"
              : item.chosen !== undefined
                ? "menuitemradio"
                : "menuitem"
          const said = item.words && typing !== item.key ? item.words.value.trim() : ""
          return (
            <button
              key={item.key}
              ref={(element) => {
                rows.current[index] = element
              }}
              type="button"
              className="request-option nodrag nopan"
              role={role}
              aria-checked={
                role === "menuitemcheckbox"
                  ? Boolean(item.check)
                  : role === "menuitemradio"
                    ? Boolean(item.chosen)
                    : undefined
              }
              aria-expanded={item.words ? typing === item.key : undefined}
              aria-controls={item.words && typing === item.key ? `${ids}-box` : undefined}
              aria-disabled={busy || undefined}
              tabIndex={on ? 0 : -1}
              data-on={on || undefined}
              data-open={(item.words && typing === item.key) || undefined}
              data-armed={armed || undefined}
              data-pressed={(busy && pressed === index) || undefined}
              data-chosen={item.chosen || undefined}
              onFocus={() => {
                if (!on) setCursor({ at: index, armed: null })
              }}
              onClick={() => {
                // A double-click's second click, landing as the host moves on, isn't for this.
                if (Date.now() < guard.current) return
                const result = pressRow(shape, { ...cursor, at: index }, index)
                setCursor(result.cursor)
                if (result.press !== null && result.press !== "send") press(result.press)
              }}
            >
              <span className="request-option-number" aria-hidden>
                {index + 1}
              </span>
              <span className="request-option-words">
                {item.check !== undefined && (
                  <span className="request-check" aria-hidden>
                    [<span className="request-check-mark">{item.check ? "✓" : ""}</span>]{" "}
                  </span>
                )}
                {item.label}
                {item.words && "…"}
                {item.pick && <span className="request-option-pick"> its pick</span>}
                {item.chosen && (
                  <span className="request-option-chosen" aria-hidden>
                    {" "}
                    ✓ your pick
                  </span>
                )}
                {armed && <span className="request-option-confirm"> ↵ again to send it</span>}
                {busy && pressed === index && (
                  <span className="request-sending" aria-hidden>
                    {" "}
                    …
                  </span>
                )}
              </span>
              {said && (
                <span className="request-option-more request-option-said">
                  <q>{said}</q>
                </span>
              )}
              {item.scope && <span className="request-option-more">{item.scope}</span>}
              {item.effect && (
                <span className="request-option-more request-option-effect">{item.effect}</span>
              )}
            </button>
          )
        })}
      </div>
      {writing && words && (
        <div className="request-writing" data-armed={armedWords || undefined}>
          <textarea
            ref={box}
            id={`${ids}-box`}
            className="request-field nodrag nopan"
            rows={1}
            value={words.value}
            placeholder={words.placeholder}
            aria-label={words.field}
            aria-required={words.required || undefined}
            aria-invalid={words.value.length > words.limit || undefined}
            aria-describedby={[`${ids}-warning`, `${ids}-keys`, words.oneLine && `${ids}-line`]
              .filter(Boolean)
              .join(" ")}
            // Read-only, not disabled, while an answer is on its way or didn't take: the words
            // stay there to select and copy.
            readOnly={busy}
            spellCheck
            data-cancels=""
            onFocus={() => {
              if (cursor.at !== open) setCursor({ at: open, armed: null })
            }}
            onChange={(event) => {
              if (armedWords) setCursor({ at: open, armed: null })
              words.onChange(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === "Escape") {
                // Back to the rows, keeping the words.
                event.preventDefault()
                event.stopPropagation()
                return back()
              }
              if (event.key !== "Enter") return
              if (event.shiftKey) {
                if (words.oneLine) event.preventDefault()
                return
              }
              if (event.ctrlKey || event.metaKey || event.altKey) return
              event.preventDefault()
              if (held(event.key, event.repeat)) return
              sendWords()
            }}
          />
          <button
            type="button"
            className="request-key nodrag nopan"
            aria-disabled={busy || !ready(words) || undefined}
            onClick={sendWords}
          >
            {armedWords ? "Send it" : "Send answer"}
            {busy && pressed === open && (
              <span className="request-sending" aria-hidden>
                {" "}
                …
              </span>
            )}
          </button>
          {words.oneLine && (
            <p className="sr-only" id={`${ids}-line`}>
              The agent's field takes one line.
            </p>
          )}
          <Hint id={`${ids}-warning`} className="request-field-hint" text={warning ?? ""} />
          <p id={`${ids}-keys`} className="request-writing-hint">
            {keys}
          </p>
        </div>
      )}
      {/* The cursor's row's details, under the rows, so that no row moves as the cursor does. */}
      {items[at]?.more && (
        <div className="request-more" role="note" aria-label={`More about ${at + 1}`}>
          <span className="request-more-of" aria-hidden>
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
