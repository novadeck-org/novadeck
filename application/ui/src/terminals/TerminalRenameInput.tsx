import { useLayoutEffect, useRef } from "react"

export type TerminalRename = {
  id: string
  value: string
  request: number
  origin: "sidebar" | "header"
}

export const TerminalRenameInput = ({
  id,
  name,
  value,
  request,
  autoFocus,
  className,
  onChange,
  onSave,
  onCancel,
}: {
  id: string
  name: string
  value: string
  request: number
  autoFocus: boolean
  className: string
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element => {
  const input = useRef<HTMLInputElement>(null)
  const focus = useRef({ request, handled: false, interacted: false })

  useLayoutEffect(() => {
    if (focus.current.request !== request)
      focus.current = { request, handled: false, interacted: false }
    const field = input.current
    if (!autoFocus || !field || focus.current.interacted) return
    if (!focus.current.handled) {
      focus.current.handled = true
      field.focus({ preventScroll: true })
      field.select()
    } else if (
      document.activeElement === field &&
      value === name &&
      (field.selectionStart !== 0 || field.selectionEnd !== field.value.length)
    ) {
      // Grid layout can update the controlled input after its first focus.
      field.select()
    }
  })

  useLayoutEffect(() => {
    const field = input.current
    if (!autoFocus || !field) return
    const restoreSelection = (): void => {
      if (
        focus.current.request !== request ||
        focus.current.interacted ||
        document.activeElement !== field ||
        value !== name ||
        (field.selectionStart === 0 && field.selectionEnd === field.value.length)
      )
        return
      // Replacing Grid's draggable heading can make Chrome finish the original
      // double-click selection against the new input and collapse its range.
      field.select()
    }
    document.addEventListener("selectionchange", restoreSelection)
    return () => document.removeEventListener("selectionchange", restoreSelection)
  }, [autoFocus, name, request, value])

  return (
    <input
      ref={input}
      data-rename-terminal={id}
      aria-label={`Rename ${name}`}
      value={value}
      maxLength={60}
      autoComplete="off"
      className={className}
      onChange={(event) => {
        focus.current.interacted = true
        onChange(event.target.value)
      }}
      onPointerDownCapture={() => {
        focus.current.interacted = true
      }}
      onKeyDown={(event) => {
        focus.current.interacted = true
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key !== "Enter" && event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === "Enter") onSave()
        else onCancel()
      }}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (
          next instanceof Element &&
          next.closest<HTMLElement>("[data-rename-terminal]")?.dataset.renameTerminal === id
        )
          return
        onSave()
      }}
    />
  )
}
