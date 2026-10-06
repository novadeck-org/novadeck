import { memo, useSyncExternalStore } from "react"

import type { Backend, BackendConnectionState } from "../backend/port"
import { WorkspaceFooter as Footer, type FooterStatus } from "../shell/WorkspaceFooter"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentState, shallowEqual } from "./selectors"

const always = (): (() => void) => () => {}
// The link's state, connected where the backend reports none.
const useConnection = (connection: Backend["connection"]): BackendConnectionState =>
  useSyncExternalStore(
    connection?.subscribe ?? always,
    () => connection?.getSnapshot() ?? "connected",
  )

// The footer wired to the workspace's counts and the backend's link.
export const WorkspaceFooter = memo((): React.JSX.Element => {
  const { backend, commands } = useWorkspaceServices()
  const connection = useConnection(backend.connection)
  const crashes = useUiState((state) => state.crashLoop)
  const zen = useUiState((state) => Boolean(state.shell.zen))
  const navigate = useUiState((state) => state.shell.navigate)
  const { count, running } = useWorkspaceState((workspace) => {
    const { terminals } = currentState(workspace).roster
    return {
      // Windows undocked from a terminal's companion aren't terminals.
      count: terminals.length,
      running: terminals.filter((terminal) => terminal.state === "running").length,
    }
  }, shallowEqual)
  const status: FooterStatus = crashes
    ? "restarting"
    : connection === "connected"
      ? "ok"
      : connection
  return (
    <Footer
      hidden={zen}
      count={count}
      running={running}
      status={status}
      navigate={navigate}
      onRetry={backend.crashLoop ? commands.retryAfterCrashLoop : undefined}
    />
  )
})
