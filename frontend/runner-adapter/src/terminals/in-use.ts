// Tells the runner which terminal the person uses in this window. A change goes out as it
// is told, one still on its way never held back by another; the runner gathers quick flips.
// A call that fails, as to a runner that came before the procedure, or while the link is
// down, is dropped: the link coming back tells it again (`connected`), the runner having
// forgotten a window's terminal along with its connection.
export const terminalInUse = (
  call: (terminalId: string | null) => Promise<unknown>,
): {
  readonly report: (terminalId: string | null) => void
  readonly connected: () => void
} => {
  let wanted: string | null = null
  let sent: string | null | undefined = null
  const send = (): void => {
    const terminalId = wanted
    sent = terminalId
    call(terminalId).catch(() => {
      // Not told, so told again once connected.
      if (sent === terminalId) sent = undefined
    })
  }
  return {
    report: (terminalId) => {
      wanted = terminalId
      if (wanted !== sent) send()
    },
    connected: () => {
      // A runner that knows none of this window yet needs only a terminal in use.
      if (wanted !== null) send()
    },
  }
}
