import type { Backend, BackendAction, RemovedElsewhere, TerminalRequest } from "@novadeck/core/port"
import type { WorkspaceStore } from "@novadeck/core/store"

// What another client removed is laid in through `removed`, which moves the person on and
// tells them when it was what they were on.
const isRemoved = (action: BackendAction): action is RemovedElsewhere =>
  action.type === "session/gone" || action.type === "project/gone"

// Starts the backend's inbound events and returns the matching stop. The sink goes
// quiet before the adapter's own stop runs, so late events from a stopped start
// never reach the store, and a late request for a terminal is refused.
export const connectBackend = (
  backend: Pick<Backend, "start">,
  store: Pick<WorkspaceStore, "transact">,
  open: (request: TerminalRequest) => void,
  removed?: (actions: readonly RemovedElsewhere[]) => void,
): (() => void) => {
  if (!backend.start) return () => {}
  let live = true
  const stop = backend.start({
    dispatch: (actions) => {
      if (!live) return
      const gone = removed ? actions.filter(isRemoved) : []
      const rest = gone.length ? actions.filter((action) => !isRemoved(action)) : actions
      if (rest.length) store.transact(rest)
      if (gone.length) removed?.(gone)
    },
    open: (request) => {
      if (live) open(request)
      else request.answer({ reason: "Novadeck closed before it opened the terminal." })
    },
  })
  return () => {
    live = false
    stop()
  }
}
