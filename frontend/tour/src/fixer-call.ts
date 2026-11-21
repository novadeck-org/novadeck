// Asks the backend to take a shell the person opened as the tour's second fixer (`tour.fixer`).
// A conflict stands: the shell is refused, and `onRefused` has the tour ask for the next one. Any
// other refusal is asked again a little later, up to `tries` times, as one while the backend
// waits on another call's shell, or a shell not ready yet, may pass; then the shell is refused
// as well. The returned stop ends the asking: a call answered after it sets no timer.
export const askFixer = (
  fixer: (terminalId: string) => Promise<void>,
  terminalId: string,
  { tries, retryMs, onRefused }: { tries: number; retryMs: number; onRefused: () => void },
): (() => void) => {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let tried = 0
  const attempt = (): void => {
    fixer(terminalId).then(undefined, (error: unknown) => {
      console.error("Novadeck couldn't start the tour's second fixer:", error)
      if ((error as { readonly code?: unknown } | null)?.code === "CONFLICT") return onRefused()
      if (stopped) return
      if (tried >= tries) return onRefused()
      tried += 1
      timer = setTimeout(attempt, retryMs)
    })
  }
  attempt()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
