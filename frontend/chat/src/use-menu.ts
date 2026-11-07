import { useState } from "react"

const rowMark = "data-menu-row"

// Whether keys in `target` type words.
export const isTyping = (target: EventTarget): boolean =>
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLInputElement && (target.type === "text" || target.type === "number"))

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
}

// A numbered menu's keys, as a terminal's: arrows move between its rows and a digit presses one.
// Focus stays where it is until the person comes here: a dialog that took it would take what they
// were typing for an answer. A row's own keys (Enter on a button, Space on a mark) stay its own.
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
  }
}
