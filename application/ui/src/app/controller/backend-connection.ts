import type { Backend } from "../../backend/port"
import type { WorkspaceStore } from "../../model/store"

// Starts the backend's inbound events and returns the matching stop. The sink goes
// quiet before the adapter's own stop runs, so late events from a stopped start
// never reach the store.
export const connectBackend = (
  backend: Pick<Backend, "start">,
  store: Pick<WorkspaceStore, "transact">,
): (() => void) => {
  if (!backend.start) return () => {}
  let live = true
  const stop = backend.start({
    dispatch: (actions) => {
      if (live) store.transact(actions)
    },
  })
  return () => {
    live = false
    stop()
  }
}
