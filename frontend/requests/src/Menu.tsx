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
import { arrivalGuardMs, isTyping, movesKey } from "./use-menu"

// A request's numbered menu, as the next lines of the terminal: a number and the words of each
// row, a dim line under them where the row says more, and a thin bar on the row the person is on.
// Keys are `menu-keys.ts`'s, and the bar follows the mouse as it does the arrows, so what is lit
// is what Enter takes. A row that takes the person's own words is a field in the row's place,
// named by the row: reaching it, by the arrows or its number, puts the person in it to type.
// It grows a line at a time; Enter sends from it, Shift+Enter starts a line where the words may
// hold several, and Esc goes back to the rows, keeping the words. While it has focus or words,
// what Enter does, why the words can't go, and a key that sends them sit small under it.
// Focus stays where it is as a menu appears, unless the host says the person arrived here from
// an answer (`arrived`), or brings it here (`focus`): either way, for a moment no key answers, so
// what they were typing elsewhere is never taken for an answer.

export type Words = {
  readonly value: string
  readonly onChange: (text: string) => void
  // The row's words, said in the field while it is empty: the row's label.
  readonly placeholder: string
  // The field's name, for a screen reader: the row's label, as words.
  readonly field: string
  readonly required: boolean
  // Why the words won't go, as a hint says it; null where they will.
  readonly refused: string | null
  // What Enter does with them, as the hint under the field says it.
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
  // Brings focus to the row the person is on, pressing nothing: true where it landed. `guard`
  // holds the answering keys back for a moment, for focus that comes while they may be typing
  // elsewhere; a click is aimed at what the menu shows, and goes.
  readonly focus: (guard: boolean) => boolean
}

// The most characters of the person's words a request's answer takes (`requestAnswer`'s text).
export const answerWordsLimit = 16_384

// Whether a field's words may go as they are.
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
  // A row pressed: answered at once, or ticked. A words row's press, in a menu of several
  // picks, ticks it; in a menu of one, it only puts the person in its field.
  readonly onPress: (at: number) => void
  // Enter in a words row's field, in a menu of one choice.
  readonly onWords?: (at: number) => void
  // Enter, in a menu of several picks.
  readonly onSend?: () => void
  // The person came into a words row's field.
  readonly onOpen?: (at: number) => void
  readonly handle?: Ref<MenuHandle> | undefined
  // The host moved on to this menu from an answer: focus comes to its first row (a words row's
  // field, where that is the first), and for a moment no key answers.
  readonly arrived?: boolean
  // The part of the page the menu before had, whose focus it may take as it arrives.
  readonly area?: (menu: Element) => Element | null
}): React.JSX.Element => {
  const [cursor, setCursor] = useState<Cursor>(startCursor)
  // The words row whose field has focus, by its key.
  const [typing, setTyping] = useState<string | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  // What takes focus for each row: its button, or a words row's field.
  const rows = useRef<(HTMLElement | null)[]>([])
  const focusTo = useRef<number | null>(null)
  const at = Math.min(cursor.at, Math.max(0, items.length - 1))
  // Opening a field for words sends nothing, so only an answer arms; the words arm as they go.
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

  // Until when neither keys nor clicks answer: set as it arrives. Where it may take focus from is
  // the host's at the time.
  const guard = useRef(0)
  // Until when keys don't answer, as focus was brought here.
  const keysGuard = useRef(0)
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
    if (!active || active === document.body || before?.contains(active)) rows.current[0]?.focus()
  }, [arrived])
  // Whether a key is to be held back: no repeat answers, nor anything as the menu arrives.
  const held = (key: string, repeat: boolean): boolean =>
    answering(key) && (repeat || Date.now() < Math.max(guard.current, keysGuard.current))

  // Focus follows the cursor once it has moved there.
  useLayoutEffect(() => {
    const to = focusTo.current
    if (to === null) return
    focusTo.current = null
    rows.current[to]?.focus()
  })

  const press = (index: number): void => {
    if (busy) return
    const item = items[index]
    if (!item) return
    // A words row's press puts the person in its field; in a menu of several picks it ticks
    // the row too, or unticks it, leaving the words out.
    if (item.words) {
      if (multi) onPress(index)
      focusTo.current = index
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
      focusTo.current = index
    },
    focus: (arming) => {
      const row = rows.current[at]
      if (!row) return false
      if (arming) keysGuard.current = Date.now() + arrivalGuardMs
      row.focus({ preventScroll: true })
      return document.activeElement === row
    },
  }))

  const sendWords = (index: number): void => {
    const item = items[index]
    const words = item?.words
    if (busy || !words || !ready(words)) return
    if (multi) return onSend?.()
    // Hard to undo: the first Enter arms, the second sends.
    if ((hard || item.arms) && cursor.armed !== index) return setCursor({ at: index, armed: index })
    setCursor({ at: index, armed: null })
    onWords?.(index)
  }
  // Esc: out of the field to the row before it, or after it, keeping the words.
  const leave = (index: number, field: HTMLTextAreaElement): void => {
    const to = index > 0 ? index - 1 : index + 1 < items.length ? index + 1 : null
    if (to === null) return field.blur()
    setCursor({ at: to, armed: null })
    focusTo.current = to
  }

  return (
    <div
      ref={menu}
      className="request-menu"
      // The person is here on purpose: the keys answer at once.
      onPointerDownCapture={() => {
        keysGuard.current = 0
      }}
      onKeyDownCapture={(event) => {
        if (movesKey(event.key)) keysGuard.current = 0
      }}
    >
      <div
        className="request-options"
        // A group of buttons, as the chat's rows always were, not an ARIA menu: the workspace
        // takes a menu on the page for an open overlay, which keeps the keys from its terminals.
        role="group"
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
          const row = event.target.closest<HTMLElement>("[data-row]")
          const index = row ? Number(row.dataset.row) : -1
          // An armed row keeps the cursor: the mouse passing over another never disarms it.
          if (index < 0 || index === at || cursor.armed !== null) return
          setCursor({ at: index, armed: null })
          // Focus goes along from anything in the menu but the person's words, which would land
          // on a row instead.
          const active = document.activeElement
          const target = rows.current[index]
          if (active && menu.current?.contains(active) && !isTyping(active))
            target?.focus({ preventScroll: true })
        }}
      >
        {items.map((item, index) => {
          const on = index === at
          const armed = cursor.armed === index
          // A row that ticks is a checkbox; one that may be the pick says whether it is.
          const ticks = !item.away && (multi || item.check !== undefined)
          const common = {
            "data-row": index,
            "data-on": on || undefined,
            "data-armed": armed || undefined,
            "data-pressed": (busy && pressed === index) || undefined,
          }
          const number = (
            <span className="request-option-number" aria-hidden>
              {index + 1}
            </span>
          )
          const check = item.check !== undefined && (
            <span className="request-check" aria-hidden>
              [<span className="request-check-mark">{item.check ? "✓" : ""}</span>]
            </span>
          )
          const sending = busy && pressed === index && (
            <span className="request-sending" aria-hidden>
              {" "}
              …
            </span>
          )
          const { words } = item
          if (words) {
            // Typed words keep the row chosen, as a pick would.
            const chosen = item.chosen ?? (item.check === undefined && words.value.trim() !== "")
            const shown = typing === item.key || words.value !== ""
            const warning =
              words.refused ?? (words.value.length > words.limit ? overLimit(words) : "")
            const keys = warning
              ? ""
              : armed
                ? "↵ again to send it"
                : words.required && words.value.trim() === ""
                  ? "type your answer · Esc back to the options"
                  : `↵ ${words.hint} · Esc back to the options`
            const id = `${ids}-${index}`
            return (
              <div
                key={item.key}
                className="request-option request-own nodrag nopan"
                role="group"
                aria-label={words.field}
                data-chosen={chosen || undefined}
                data-typing={typing === item.key || undefined}
                {...common}
                data-check={item.check === undefined ? undefined : item.check}
                onClick={(event) => {
                  if (!(event.target instanceof Element) || Date.now() < guard.current) return
                  // Its number or its mark presses it, ticking or unticking it in a menu of
                  // several picks; anywhere else but its field or its key puts the person in it.
                  if (event.target.closest(".request-option-number, .request-check"))
                    return press(index)
                  if (!event.target.closest("textarea, button")) rows.current[index]?.focus()
                }}
              >
                {number}
                <span className="request-own-line">
                  {check}
                  <textarea
                    ref={(element) => {
                      rows.current[index] = element
                    }}
                    className="request-field"
                    rows={1}
                    value={words.value}
                    placeholder={words.placeholder}
                    aria-label={words.field}
                    aria-required={words.required || undefined}
                    aria-invalid={words.value.length > words.limit || undefined}
                    aria-describedby={[
                      `${id}-warning`,
                      `${id}-keys`,
                      words.oneLine && `${id}-line`,
                      item.check !== undefined && `${id}-check`,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    // Read-only, not disabled, while an answer is on its way or didn't take: the
                    // words stay there to select and copy.
                    readOnly={busy}
                    tabIndex={on ? 0 : -1}
                    spellCheck
                    data-cancels=""
                    onFocus={() => {
                      if (typing !== item.key) {
                        setTyping(item.key)
                        onOpen?.(index)
                      }
                      if (!on) setCursor({ at: index, armed: null })
                    }}
                    onBlur={(event) => {
                      // To its own key, it stays: the hints stay put under it.
                      if (event.currentTarget.closest("[data-row]")?.contains(event.relatedTarget))
                        return
                      setTyping((now) => (now === item.key ? null : now))
                    }}
                    onChange={(event) => {
                      if (armed) setCursor({ at: index, armed: null })
                      words.onChange(event.target.value)
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return
                      const field = event.currentTarget
                      if (event.key === "Escape") {
                        event.preventDefault()
                        event.stopPropagation()
                        return leave(index, field)
                      }
                      // Up from its start, or down from its end, goes on to the next row.
                      const start = field.selectionStart === 0 && field.selectionEnd === 0
                      const end =
                        field.selectionStart === field.value.length &&
                        field.selectionEnd === field.value.length
                      const plain =
                        !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
                      if (
                        plain &&
                        ((event.key === "ArrowUp" && start) || (event.key === "ArrowDown" && end))
                      ) {
                        event.preventDefault()
                        event.stopPropagation()
                        apply(event.key)
                        return
                      }
                      if (event.key !== "Enter") return
                      if (event.shiftKey) {
                        if (words.oneLine) event.preventDefault()
                        return
                      }
                      if (event.ctrlKey || event.metaKey || event.altKey) return
                      event.preventDefault()
                      event.stopPropagation()
                      if (held(event.key, event.repeat)) return
                      sendWords(index)
                    }}
                  />
                </span>
                {/* Under the row, small: always in the page, so a screen reader hears a warning
                    as it comes; the rest only while the person is in the field or has words. */}
                <div className="request-own-foot" data-shown={shown || undefined}>
                  <Hint
                    id={`${id}-warning`}
                    className="request-field-hint"
                    text={shown ? warning : ""}
                  />
                  {item.check !== undefined && (
                    <span className="sr-only" id={`${id}-check`}>
                      {item.check ? "Ticked." : "Not ticked."}
                    </span>
                  )}
                  {words.oneLine && (
                    <span className="sr-only" id={`${id}-line`}>
                      The agent's field takes one line.
                    </span>
                  )}
                  <span id={`${id}-keys`} className="request-writing-hint">
                    {shown ? keys : ""}
                  </span>
                  {shown && (
                    <button
                      type="button"
                      className="request-key"
                      tabIndex={-1}
                      aria-disabled={busy || !ready(words) || undefined}
                      onClick={() => sendWords(index)}
                    >
                      {armed ? "Send it" : "Send answer"}
                      {sending}
                    </button>
                  )}
                </div>
                {item.scope && <span className="request-option-more">{item.scope}</span>}
                {item.effect && (
                  <span className="request-option-more request-option-effect">{item.effect}</span>
                )}
              </div>
            )
          }
          return (
            <button
              key={item.key}
              ref={(element) => {
                rows.current[index] = element
              }}
              type="button"
              className="request-option nodrag nopan"
              role={ticks ? "checkbox" : undefined}
              aria-checked={ticks ? Boolean(item.check) : undefined}
              aria-pressed={!ticks && item.chosen !== undefined ? item.chosen : undefined}
              aria-disabled={busy || undefined}
              tabIndex={on ? 0 : -1}
              data-chosen={item.chosen || undefined}
              {...common}
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
              {number}
              <span className="request-option-words">
                {check && <>{check} </>}
                {item.label}
                {item.pick && <span className="request-option-pick"> its pick</span>}
                {item.chosen && (
                  <span className="request-option-chosen" aria-hidden>
                    {" "}
                    ✓ your pick
                  </span>
                )}
                {armed && <span className="request-option-confirm"> ↵ again to send it</span>}
                {sending}
              </span>
              {item.scope && <span className="request-option-more">{item.scope}</span>}
              {item.effect && (
                <span className="request-option-more request-option-effect">{item.effect}</span>
              )}
            </button>
          )
        })}
      </div>
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
