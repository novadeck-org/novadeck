import type { ChatItem, ChatSlice } from "@novadeck/core/conversation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

// A command run through a harness's own menu, as the person's words: a transcript records
// almost none of them. Its `slice` is the last of the view it opened, as what it printed.
export type Echo = {
  readonly id: number
  readonly text: string
  readonly at: number
  readonly slice: ChatSlice | null
}

// The most the chat keeps of them; they last as long as it does.
const most = 8

// How long after Enter a view counts as the command's, in milliseconds.
export const viewMs = 3000

// How far before Enter a transcript's own item of a command may be dated, in milliseconds.
const recordedMs = 2000

const recorded = (echo: Echo, items: readonly ChatItem[]): boolean =>
  items.some(
    (item) =>
      item.role === "user" &&
      item.text.trim() === echo.text &&
      (item.at ?? 0) >= echo.at - recordedMs,
  )

export const useEchoes = (
  slice: ChatSlice | null,
  items: readonly ChatItem[],
): {
  readonly shown: readonly Echo[]
  readonly echo: (text: string) => void
  readonly drop: () => void
} => {
  const [echoes, setEchoes] = useState<readonly Echo[]>([])
  // The command whose view may still come or stay, and whether it came.
  const open = useRef<{
    readonly id: number
    readonly until: number
    seen: boolean
    last: ChatSlice | null
  } | null>(null)
  const count = useRef(0)

  const echo = useCallback((text: string): void => {
    count.current += 1
    const id = count.current
    const at = Date.now()
    open.current = { id, until: at + viewMs, seen: false, last: null }
    setEchoes((current) => [...current, { id, text, at, slice: null }].slice(-most))
  }, [])

  // The last one ran nothing: an Enter the harness kept the text through.
  const drop = useCallback((): void => {
    const command = open.current
    if (!command || command.seen) return
    open.current = null
    setEchoes((current) => current.filter((each) => each.id !== command.id))
  }, [])

  useEffect(() => {
    const command = open.current
    if (!command) return
    if (slice?.reason === "view") {
      if (!command.seen && Date.now() > command.until) {
        open.current = null
        return
      }
      command.seen = true
      // Nothing keeps a copy of a secret prompt, an earlier row of the same view neither.
      command.last = slice.secret ? null : slice
      if (slice.secret) open.current = null
      return
    }
    if (!command.seen) {
      if (Date.now() > command.until) open.current = null
      return
    }
    // Its view went: the last of it stays as what it printed, where the live rows were.
    open.current = null
    const { id, last } = command
    setEchoes((current) =>
      current.map((each) => (each.id === id ? { ...each, slice: last } : each)),
    )
  }, [slice])

  const shown = useMemo(() => echoes.filter((each) => !recorded(each, items)), [echoes, items])
  return { shown, echo, drop }
}
