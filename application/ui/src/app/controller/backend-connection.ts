import type { Backend, TerminalRequest } from "../../backend/port"
import type { WorkspaceStore } from "../../model/store"

// Starts the backend's inbound events and returns the matching stop. The sink goes
// quiet before the adapter's own stop runs, so late events from a stopped start
// never reach the store, and a late request for a terminal is refused.
export const connectBackend = (
  backend: Pick<Backend, "start">,
  store: Pick<WorkspaceStore, "transact">,
  open: (request: TerminalRequest) => void,
): (() => void) => {
  if (!backend.start) return () => {}
  let live = true
  const stop = backend.start({
    dispatch: (actions) => {
      if (live) store.transact(actions)
    },
    open: (request) => {
      if (live) open(request)
      else request.answer({ reason: "NovaDeck closed before it opened the terminal." })
    },
  })
  return () => {
    live = false
    stop()
  }
}
