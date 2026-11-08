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
  // Asks once more, now, by a read that starts after the call, and keeps the answer: whether
  // the restart may go on, which it may not where the answer names work of a terminal the card
  // can show that it did not show. A failed or empty answer lets it go on, as the card already
  // shows what it could not tell.
  readonly recheck: () => Promise<boolean>
}

// How long after an answer the next is asked for, while someone still looks.
export const askAgainMs = 5_000

// Asks `ask` while `active`, once at the start and again `askAgainMs` after each answer, and
// never otherwise: reading it costs the runner a look at the system's processes, so nothing
// asks on a timer for nobody. What it learned is dropped when `active` ends, so a later look
// starts from pending rather than a stale answer, and an answer that comes after is let go.
export const useBusyTerminals = (
  ask: Ask | undefined,
  active: boolean,
  // Whether the card can show this terminal: the ones this window has.
  shows: (terminalId: string) => boolean,
): BusyTerminals => {
  const [found, setFound] = useState<Told | null | undefined>(undefined)
  const shown = useRef(found)
  const canShow = useRef(shows)
  useEffect(() => {
    shown.current = found
    canShow.current = shows
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
  const recheck = useCallback(async (): Promise<boolean> => {
    if (!ask) return true
    const told = await ask({ fresh: true }).catch(() => undefined)
    if (!told) return true
    const before = shown.current
    const seen = new Set([...(before?.busy ?? []), ...(before?.unknown ?? [])])
    setFound(told)
    return [...told.busy, ...told.unknown].every((id) => seen.has(id) || !canShow.current(id))
  }, [ask])
  const busy = useMemo(
    () => (found ? { busy: new Set(found.busy), unknown: new Set(found.unknown) } : undefined),
    [found],
  )
  if (!ask) return { busy: undefined, answer: "known", recheck }
  if (found === undefined) return { busy: undefined, answer: "pending", recheck }
  if (found === null) return { busy: undefined, answer: "unavailable", recheck }
  return { busy, answer: "known", recheck }
}
