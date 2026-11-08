import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { RestartBusy } from "../shell/restart-check"

// The runner's word on the shells that hold work a close would end, and those it couldn't read.
type Told = { readonly busy: readonly string[]; readonly unknown: readonly string[] }
type Ask = (options?: { readonly fresh?: true }) => Promise<Told | undefined>

export type BusyTerminals = {
  readonly busy: RestartBusy | undefined
  // `pending` until the first answer, `unavailable` when it answers nothing (an older runner,
  // a failure), `known` otherwise; always `known` where there is nothing to ask.
  readonly answer: "pending" | "known" | "unavailable"
  // Asks once more, now, by a read that starts after the call, and keeps the answer, which it
  // gives back: the one the card then shows. A failed or empty answer gives back undefined and
  // changes nothing, except while the first answer is still pending, when it makes the card say
  // it couldn't check, as the person is about to act on what it never said.
  readonly refresh: () => Promise<Told | undefined>
}

// How long after an answer the next is asked for, while someone still looks.
export const askAgainMs = 5_000

// Asks `ask` while `active`, once at the start and again `askAgainMs` after each answer, and
// never otherwise: reading it costs the runner a look at the system's processes, so nothing
// asks on a timer for nobody. What it learned is dropped when `active` ends, so a later look
// starts from pending rather than a stale answer, and an answer that comes after is let go.
export const useBusyTerminals = (ask: Ask | undefined, active: boolean): BusyTerminals => {
  const [found, setFound] = useState<Told | null | undefined>(undefined)
  const shown = useRef(found)
  useEffect(() => {
    shown.current = found
  })
  useEffect(() => {
    if (!ask || !active) return undefined
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const answered = (told: Told | null): void => {
      if (!current) return
      setFound(told)
      timer = setTimeout(read, askAgainMs)
    }
    const read = (): void => {
      ask().then(
        (told) => answered(told ?? null),
        () => answered(null),
      )
    }
    read()
    return () => {
      current = false
      clearTimeout(timer)
      setFound(undefined)
    }
  }, [ask, active])
  const refresh = useCallback(async (): Promise<Told | undefined> => {
    if (!ask) return undefined
    const told = await ask({ fresh: true }).catch(() => undefined)
    if (told) setFound(told)
    else if (shown.current === undefined) setFound(null)
    return told
  }, [ask])
  const busy = useMemo(
    () => (found ? { busy: new Set(found.busy), unknown: new Set(found.unknown) } : undefined),
    [found],
  )
  if (!ask) return { busy: undefined, answer: "known", refresh }
  if (found === undefined) return { busy: undefined, answer: "pending", refresh }
  if (found === null) return { busy: undefined, answer: "unavailable", refresh }
  return { busy, answer: "known", refresh }
}
