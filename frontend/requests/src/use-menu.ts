import { useEffect, useRef, useState } from "react"

const rowMark = "data-menu-row"

// Whether keys in `target` type words.
export const isTyping = (target: EventTarget): boolean =>
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLInputElement && (target.type === "text" || target.type === "number"))

// Whether `target` holds words the person typed, which focus moving away would leave mid-thought.
export const holdsWords = (target: Element): boolean =>
  (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) &&
  isTyping(target) &&
  target.value !== ""

export type Menu = {
  // The row the person is on.
  readonly at: number
  // What a row's focusable element takes, to be found, and to take the keys.
  readonly row: (index: number) => {
    readonly [rowMark]: true
    readonly tabIndex: number
    readonly onFocus: () => void
  }
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
  // The bar follows the mouse, and so do the keys while they are in the dialog already.
  readonly onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
}

// A numbered menu's keys, as a terminal's: arrows move between its rows and a digit presses one.
// Focus stays where it is until the person comes here: a dialog that took it would take what they
// were typing for an answer. A row's own keys (Enter on a button, Space on a mark) stay its own.
// The mouse moves the bar as the arrows do, so what is lit is what Enter takes.
export const useMenu = (count: number): Menu => {
  const [cursor, setCursor] = useState(0)
  const at = Math.min(cursor, Math.max(count - 1, 0))
  return {
    at,
    row: (index) => ({
      [rowMark]: true,
      tabIndex: index === at ? 0 : -1,
      onFocus: () => setCursor(index),
    }),
    onKeyDown: (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || count === 0) return
      const rows = event.currentTarget.querySelectorAll<HTMLElement>(`[${rowMark}]`)
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        rows[(at + (event.key === "ArrowDown" ? 1 : count - 1)) % count]?.focus()
      } else if (/^[1-9]$/.test(event.key) && !event.repeat && !isTyping(event.target)) {
        const row = rows[Number(event.key) - 1]
        if (!row) return
        event.preventDefault()
        row.focus()
        row.click()
      }
    },
    onPointerMove: (event) => {
      if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return
      const option = event.target.closest(".request-option")
      if (!option || !event.currentTarget.contains(option)) return
      const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(`[${rowMark}]`)]
      const index = rows.findIndex((row) => row === option || option.contains(row))
      const row = rows[index]
      if (!row || index === at || row.matches(":disabled")) return
      const active = document.activeElement
      // Focus goes along from anything in the dialog but a field the person writes in, empty
      // or not: their words would land on a row instead.
      if (active && option.closest(".request-dialog")?.contains(active) && !isTyping(active))
        row.focus({ preventScroll: true })
      else setCursor(index)
    },
  }
}

// How long a dialog the host moved on to takes no answer from the keyboard or a click: a key
// pressed twice, or held, for the one before never answers the next.
export const arrivalGuardMs = 400

export type ArrivalGuard = {
  // Whether the dialog is within its moment of arrival, which holds clicks and keys.
  readonly on: () => boolean
  // Whether its answering keys are held: as it arrives, or as focus came to it.
  readonly keysHeld: () => boolean
  // Holds its answering keys for a moment, as focus comes to it from what the person was
  // typing; a click is aimed at what it shows, and goes.
  readonly holdKeys: () => void
  // The person is here on purpose (a press, a key that moves): the keys answer at once.
  readonly release: () => void
}

// The dialog's moment of arrival, as its host moves on to it (`arrived`), and the keys it holds
// as focus is brought to it.
export const useArrivalGuard = (arrived: boolean): ArrivalGuard => {
  const until = useRef(0)
  const keysUntil = useRef(0)
  useEffect(() => {
    if (arrived) until.current = Date.now() + arrivalGuardMs
  }, [arrived])
  return {
    on: () => Date.now() < until.current,
    keysHeld: () => Date.now() < Math.max(until.current, keysUntil.current),
    holdKeys: () => {
      keysUntil.current = Date.now() + arrivalGuardMs
    },
    release: () => {
      keysUntil.current = 0
    },
  }
}

// Whether a key moves about a dialog, which the person presses there on purpose.
export const movesKey = (key: string): boolean =>
  key === "ArrowDown" ||
  key === "ArrowUp" ||
  key === "ArrowLeft" ||
  key === "ArrowRight" ||
  key === "Home" ||
  key === "End" ||
  key === "Tab"

// Whether a key answers, rather than moves: what the guard holds back.
export const answersKey = (key: string): boolean =>
  /^[1-9]$/.test(key) || key === "Enter" || key === " "

// A key pressed outside a menu's rows (on the host's own row or title), taken by the rows under
// `root` as their own keys would: a digit goes to its row and presses it, an arrow moves on from
// the row the person is on, stopping at either end. True where the key was the rows'.
export const forwardKey = (root: Element | null | undefined, key: string): boolean => {
  const rows = root ? [...root.querySelectorAll<HTMLElement>(`[${rowMark}]`)] : []
  if (rows.length === 0) return false
  if (/^[1-9]$/.test(key)) {
    const row = rows[Number(key) - 1]
    if (!row) return false
    row.focus()
    row.click()
    return true
  }
  if (key !== "ArrowDown" && key !== "ArrowUp") return false
  const at = Math.max(
    0,
    rows.findIndex((row) => row.tabIndex === 0),
  )
  rows[Math.min(rows.length - 1, Math.max(0, at + (key === "ArrowDown" ? 1 : -1)))]?.focus()
  return true
}

// Focus to a row of the menu under `root`, pressing nothing.
export const goToRow = (root: Element | null | undefined, at: number): void =>
  root?.querySelectorAll<HTMLElement>(`[${rowMark}]`)[at]?.focus()
