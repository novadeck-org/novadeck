import { useState } from "react"

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
      const option = event.target.closest(".chat-option")
      if (!option || !event.currentTarget.contains(option)) return
      const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(`[${rowMark}]`)]
      const index = rows.findIndex((row) => row === option || option.contains(row))
      const row = rows[index]
      if (!row || index === at || row.matches(":disabled")) return
      const active = document.activeElement
      // Focus goes along only from another row the keys pick with: never out of a field the
      // person is about to write in, where their words would land on a row instead.
      if (
        active?.hasAttribute(rowMark) &&
        option.closest(".chat-dialog")?.contains(active) &&
        !isTyping(active)
      )
        row.focus({ preventScroll: true })
      else setCursor(index)
    },
  }
}
