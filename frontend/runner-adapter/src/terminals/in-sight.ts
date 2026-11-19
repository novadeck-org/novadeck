import { retryMs } from "./in-use"

const key = (ids: readonly string[]): string => ids.join("\n")

// Tells the runner which terminals this window has in sight (`terminals.seen`), whole each
// time: the runner takes the list as the window's, replacing its last, and drops it with the
// connection. Changes made in one tick go out as one call, and one that leaves the list as the
// runner has it goes out not at all. A call that fails is told once more after `retryMs`
// while still wanted; the link coming back tells the list again (`connected`), the runner
// having forgotten it along with the connection.
export const terminalsInSight = (
  call: (terminalIds: string[]) => Promise<unknown>,
): {
  readonly report: (terminalIds: ReadonlySet<string>) => void
  readonly connected: () => void
} => {
  let wanted: string[] = []
  // The list the runner has, or undefined where it may not.
  let sent: string | undefined = ""
  let scheduled = false
  const send = (retry: boolean): void => {
    const ids = wanted
    sent = key(ids)
    call(ids).catch(() => {
      if (sent !== key(ids)) return
      sent = undefined
      if (retry)
        setTimeout(() => {
          if (sent === undefined && key(wanted) === key(ids)) send(false)
        }, retryMs)
    })
  }
  return {
    report: (terminalIds) => {
      wanted = [...terminalIds].toSorted()
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (key(wanted) !== sent) send(true)
      })
    },
    connected: () => {
      // A runner that knows none of this window yet needs only what is in sight.
      if (wanted.length > 0) send(true)
    },
  }
}
