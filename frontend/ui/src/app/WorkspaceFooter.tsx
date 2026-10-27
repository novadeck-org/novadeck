import { movedOrder, nextAccountReset, runningSeats, sameSeats } from "@novadeck/core/account-usage"
import { nextWaitingChange } from "@novadeck/core/agent-waiting"
import type { Backend, BackendConnectionState } from "@novadeck/core/port"
import { waitingAgents } from "@novadeck/core/terminal-ending"
import { memo, useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { FeedbackButton } from "../feedback/FeedbackButton"
import { readSubscriptionOrder, writeSubscriptionOrder } from "../shell/shell-storage"
import { SubscriptionUsage } from "../shell/SubscriptionUsage"
import { WorkspaceFooter as Footer, type FooterStatus } from "../shell/WorkspaceFooter"
import { useRenderAt } from "../terminals/use-render-at"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useAccounts } from "./controller/footer-accounts"
import { crashLoopQuestion, currentState, shallowEqual } from "./selectors"
import { dismissWhatsNew } from "./ui-store"
import { useOfferNews } from "./use-offer-news"

const always = (): (() => void) => () => {}
// The link's state, connected where the backend reports none.
const useConnection = (connection: Backend["connection"]): BackendConnectionState =>
  useSyncExternalStore(
    connection?.subscribe ?? always,
    () => connection?.getSnapshot() ?? "connected",
  )

// The footer wired to the workspace's counts, the account's subscriptions and the
// backend's link.
export const WorkspaceFooter = memo((): React.JSX.Element => {
  const { backend, commands, navigation, ui, workspace: store } = useWorkspaceServices()
  const { updates, portable: portableHost } = backend
  const connection = useConnection(backend.connection)
  const crashes = useUiState((state) => state.crashLoop)
  const offer = useUiState((state) => state.update)
  const portableCardOpen = useUiState((state) => state.portableCardOpen)
  const whatsNew = useUiState((state) => state.whatsNew)
  const sandbox = useUiState((state) => state.sandbox)
  const sandboxOpen = useUiState((state) => state.sandboxOpen)
  const portableState = useUiState((state) => state.portable)
  const portable = portableState?.portable === true
  // A host that can say it is portable has not yet: the sandbox chip waits, so it does not
  // flash on a copy whose install entry replaces it.
  const portablePending = useUiState((state) => state.portable === null) && !!portableHost
  const {
    news,
    settled: newsSettled,
    askAgain,
  } = useOfferNews(portable ? portableHost?.news : undefined, offer)
  // The card coming up asks again for notes a failure that may pass left out.
  const portableShown = useCallback(() => {
    commands.portableCardShown()
    askAgain()
  }, [commands, askAgain])
  // A dialog, the switcher or a question holds the notice back until it is answered.
  const asking = useUiState(
    (state) =>
      state.location.route.dialog !== null ||
      state.closing !== null ||
      state.recent.switcher !== null ||
      crashLoopQuestion(state) > 0,
  )
  const welcome = useSyncExternalStore(
    backend.agents?.welcome.subscribe ?? always,
    () => backend.agents?.welcome.getSnapshot() ?? false,
  )
  const murmurState = useSyncExternalStore(backend.murmur?.state.subscribe ?? always, () =>
    backend.murmur?.state.getSnapshot(),
  )
  const zen = useUiState((state) => Boolean(state.shell.zen))
  const navigate = useUiState((state) => state.shell.navigate)
  const { count, running, waiting, waitingChange } = useWorkspaceState((workspace) => {
    const { terminals } = currentState(workspace).roster
    const now = Date.now()
    // Agents that ended their turn to wait on something count apart, never as running; a
    // wake-up passing makes one idle again, so the count is read again then.
    const waits = waitingAgents(terminals, now)
    return {
      waiting: waits.length,
      waitingChange: waits.reduce<number | undefined>((soonest, terminal) => {
        const next = nextWaitingChange(terminal, now)
        return next === undefined || (soonest !== undefined && soonest < next) ? soonest : next
      }, undefined),
      // Windows undocked from a terminal's companion aren't terminals.
      count: terminals.length,
      // Not those that wait, which are counted apart.
      running: terminals.filter((terminal) => terminal.state === "running").length - waits.length,
    }
  }, shallowEqual)
  useRenderAt(waitingChange)
  const seats = useWorkspaceState(runningSeats, sameSeats)
  // The order the person left the subscriptions in, kept for their next visit.
  const [order, setOrder] = useState(readSubscriptionOrder)
  // The time windows are measured against, moved on as the soonest one resets, so it
  // drops out then though no agent reports anything new.
  const [now, setNow] = useState(Date.now)
  const accounts = useAccounts(backend.telemetry, seats, now, order)
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
      waiting={waiting}
      status={status}
      navigate={navigate}
      onRetry={backend.crashLoop ? commands.retryAfterCrashLoop : undefined}
      // A copy that updates itself shows only its downloads; a portable one, which can't,
      // has its install entry, with the release it is missing.
      progress={updates && !portable ? offer : null}
      noticeOpen={sandboxOpen}
      // It takes turns with the other notices in its corner: a dialog, the sandbox notice or
      // a portable copy's card (which an installed copy that was updated never has) goes first.
      whatsNew={
        whatsNew && backend.whatsNew
          ? {
              notes: whatsNew,
              blocked: asking || welcome || sandboxOpen || (portable && portableCardOpen),
              onDismiss: () => dismissWhatsNew(backend.whatsNew, ui),
              returnFocus: () => {
                const { selected, view } = currentState(store.getSnapshot())
                if (!selected) return false
                commands.setKeyboardFocus({ id: selected, view })
                return true
              },
            }
          : undefined
      }
      available={
        updates && !portable && !portablePending && offer?.kind === "available"
          ? {
              version: offer.version,
              onOpenPage: updates.openPage,
              onAllow: offer.allow === true ? updates.allow : undefined,
            }
          : undefined
      }
      portable={
        portable && portableHost
          ? {
              offer: updates ? (offer ?? undefined) : undefined,
              news,
              newsSettled,
              portable: {
                // The install entry covers the sandbox notice a portable copy would show.
                unsandboxed: sandbox !== null && !sandbox.sandboxed,
                onInstall: portableHost.install,
                install:
                  portableState?.portable === true ? portableState.install : { phase: "idle" },
                dataFolder: portableState?.portable === true ? portableState.dataFolder : undefined,
                onDownload: portableHost.openDownload,
                onShowFolder: portableHost.showDataFolder,
              },
              open: portableCardOpen,
              blocked: asking || welcome || sandboxOpen,
              onOpenChange: commands.setPortableCardOpen,
              onShown: portableShown,
              returnFocus: () => {
                const { selected, view } = currentState(store.getSnapshot())
                if (!selected) return false
                commands.setKeyboardFocus({ id: selected, view })
                return true
              },
            }
          : undefined
      }
      murmur={
        backend.murmur && murmurState
          ? {
              state: murmurState,
              actions: backend.murmur,
              blocked: asking || welcome || sandboxOpen || (portable && portableCardOpen),
              returnFocus: () => {
                const { selected, view } = currentState(store.getSnapshot())
                if (selected) commands.setKeyboardFocus({ id: selected, view })
              },
              openAddons: () => navigation.go({ dialog: "preferences", section: "addons" }),
            }
          : undefined
      }
      sandbox={
        sandbox && !sandbox.sandboxed && !portable && !portablePending
          ? {
              fix: sandbox.fix,
              open: sandboxOpen,
              blocked: asking || welcome,
              onOpenChange: commands.setSandboxOpen,
            }
          : undefined
      }
      usage={<SubscriptionUsage accounts={accounts} onMove={move} />}
      feedback={backend.feedback && <FeedbackButton feedback={backend.feedback} />}
    />
  )
})
