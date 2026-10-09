import { memo, useEffect, useMemo, useState, useSyncExternalStore } from "react"

import type { Backend, BackendConnectionState } from "../backend/port"
import { accountUsage, movedOrder, nextAccountReset } from "../model/account-usage"
import type { Workspace } from "../model/types"
import { readSubscriptionOrder, writeSubscriptionOrder } from "../shell/shell-storage"
import { SubscriptionUsage } from "../shell/SubscriptionUsage"
import { WorkspaceFooter as Footer, type FooterStatus } from "../shell/WorkspaceFooter"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentState, sameItems, shallowEqual } from "./selectors"

const always = (): (() => void) => () => {}
// The link's state, connected where the backend reports none.
const useConnection = (connection: Backend["connection"]): BackendConnectionState =>
  useSyncExternalStore(
    connection?.subscribe ?? always,
    () => connection?.getSnapshot() ?? "connected",
  )

// Every terminal in every session: subscriptions are the account's, whichever reports them.
const allTerminals = (workspace: Workspace) =>
  workspace.projects.flatMap((project) =>
    project.history.flatMap((session) => session.state.roster.terminals),
  )

// The footer wired to the workspace's counts, the account's subscriptions and the
// backend's link.
export const WorkspaceFooter = memo((): React.JSX.Element => {
  const { backend, commands } = useWorkspaceServices()
  const connection = useConnection(backend.connection)
  const crashes = useUiState((state) => state.crashLoop)
  const update = useUiState((state) => state.updateReady)
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
  const terminals = useWorkspaceState(allTerminals, sameItems)
  // The order the person left the subscriptions in, kept for their next visit.
  const [order, setOrder] = useState(readSubscriptionOrder)
  // The time windows are measured against, moved on as the soonest one resets, so it
  // drops out then though no agent reports anything new.
  const [now, setNow] = useState(Date.now)
  const accounts = useMemo(() => accountUsage(terminals, now, order), [terminals, now, order])
  const nextReset = nextAccountReset(accounts)
  useEffect(() => {
    if (nextReset === undefined) return undefined
    // A timer waits at most about 24.8 days; a reset further off is waited for in turns.
    const longest = 2 ** 31 - 1
    let timer: ReturnType<typeof setTimeout>
    const wait = (): void => {
      const left = Math.max(0, nextReset - Date.now()) + 50
      timer = setTimeout(left > longest ? wait : () => setNow(Date.now()), Math.min(left, longest))
    }
    wait()
    return () => clearTimeout(timer)
  }, [nextReset])
  const move = (from: number, to: number): void => {
    const next = movedOrder(accounts, order, from, to)
    setOrder(next)
    writeSubscriptionOrder(next)
  }
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
      update={update && backend.updates ? update : undefined}
      onInstall={backend.updates?.install}
      usage={<SubscriptionUsage accounts={accounts} onMove={move} />}
    />
  )
})
