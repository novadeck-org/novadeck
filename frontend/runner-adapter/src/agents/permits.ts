import type { ChatPermit } from "@novadeck/core/conversation"
import type { AgentDetail } from "@novadeck/protocol"
import { hasCode } from "@novadeck/runner-client"

// The shipping gate's standing permits, as the adapter reads them from an agent's detail, and
// the one call that takes one back. A runner from before them sends none.

export const permitsOf = (detail: AgentDetail): readonly ChatPermit[] =>
  (detail.permits ?? []).map(({ id, title, quote, givenAt, until, usedAt }) => ({
    id,
    title,
    quote,
    givenAt,
    until,
    usedAt,
  }))

export const samePermits = (a: readonly ChatPermit[], b: readonly ChatPermit[]): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b)

// Takes a permit back through the runner's call, which resolves whether one stood. A permit that
// no longer stood is no success: the person is told, and the detail's next listing takes it off.
export const takeBackOf =
  (
    call: (terminalId: string, permit: string) => Promise<{ readonly ended: boolean }>,
    track: <T>(work: Promise<T>) => Promise<T>,
  ) =>
  (terminalId: string, permit: string): Promise<void> =>
    track(call(terminalId, permit)).then(
      ({ ended }) => {
        if (!ended) throw new Error("It had already ended.")
      },
      (error: unknown) => {
        if (hasCode(error, "DISCONNECTED", "CLOSED")) throw new Error("The runner is offline.")
        if (hasCode(error, "NOT_FOUND")) throw new Error("That agent is gone.")
        throw new Error("Couldn't take it back. Try again.")
      },
    )

// The runner client's `agents.takeBack`, where the runner has the procedure (`supports`; a client
// that can't say has none) and the client lists it among its `agents` calls. Until the client
// does, the call is read off the object by name; a client without it gives none, and no permit
// shows.
type TakesBack = {
  readonly supports?: (path: "agents.takeBack") => boolean
  readonly agents: {
    readonly takeBack?: (terminalId: string, permit: string) => Promise<{ readonly ended: boolean }>
  }
}

export const takeBackCall = (
  runner: object,
): ((terminalId: string, permit: string) => Promise<{ readonly ended: boolean }>) | undefined => {
  const { supports, agents } = runner as TakesBack
  if (typeof supports !== "function" || !supports.call(runner, "agents.takeBack")) return undefined
  return agents.takeBack && ((terminalId, permit) => agents.takeBack!(terminalId, permit))
}
