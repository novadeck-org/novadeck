import { useEffect, useEffectEvent, useState, type ReactNode } from "react"

import type {
  BackendConnection,
  BackendSelection,
  BootProgress,
  ConnectFailure,
  CreateBackend,
} from "../backend/port"
import {
  autoRetryDelay,
  bootFill,
  bootLine,
  failureOf,
  onlineHoldMs,
  splashFadeMs,
  type BootStage,
} from "./boot"
import { BootFailure } from "./BootFailure"
import { BootSplash } from "./BootSplash"

// Where the splash stands once the workspace reports it is attached: saying so, fading
// out, then gone.
type Lift = "up" | "online" | "leaving" | "gone"

type Phase = "connecting" | "loading" | "ready"

type GateProps = {
  // Read once when the gate mounts.
  readonly selection: BackendSelection
  // The workspace, once the backend can be created. It mounts behind the splash and
  // reports, through `boot`, how far its terminals are from attached.
  readonly render: (
    createBackend: CreateBackend,
    boot: (progress: BootProgress) => void,
  ) => ReactNode
}

// One attempt to reach the backend. It keeps the connection, and the workspace on it,
// while it stays mounted, and tells the gate how it is going.
const Attempt = ({
  selection,
  render,
  onPhase,
  onFailed,
}: {
  readonly selection: BackendSelection
  readonly render: (createBackend: CreateBackend) => ReactNode
  readonly onPhase: (phase: Phase) => void
  readonly onFailed: (failure: ConnectFailure) => void
}): ReactNode => {
  const [createBackend, setCreateBackend] = useState(() =>
    "createBackend" in selection ? selection.createBackend : undefined,
  )
  const phase = useEffectEvent(onPhase)
  const failed = useEffectEvent(onFailed)
  useEffect(() => {
    if (!("connect" in selection)) return
    const controller = new AbortController()
    let connection: BackendConnection | undefined
    selection
      .connect(controller.signal, () => {
        if (!controller.signal.aborted) phase("loading")
      })
      .then(
        (connected) => {
          if (controller.signal.aborted) return connected.close()
          connection = connected
          setCreateBackend(() => connected.createBackend)
          phase("ready")
        },
        (error: unknown) => {
          if (!controller.signal.aborted) failed(failureOf(error))
        },
      )
    return () => {
      controller.abort()
      connection?.close()
    }
  }, [selection])
  return createBackend ? render(createBackend) : null
}

const ignore = (): void => {}

const stageOf = (phase: Phase, boot: BootProgress | null, lift: Lift): BootStage => {
  if (lift !== "up") return { phase: "online" }
  if (phase === "connecting") return { phase: "connecting" }
  if (phase === "ready" && boot) return { phase: "attaching", progress: boot }
  return { phase: "loading" }
}

// Holds the workspace back until its backend is reachable, since the seed comes from
// it, and keeps the boot splash over it until the restored terminals are attached.
// When connecting fails the splash stays and explains it in place, retrying transient
// failures on its own a few times.
export const BackendGate = ({ selection, render }: GateProps): ReactNode => {
  const [initial] = useState(selection)
  // A backend ready at once, as in tests, needs no splash.
  const splashed = "connect" in initial
  // Each retry is a fresh attempt; on desktop it also asks the host for a new runner.
  // `attempt` keys the attempts over the gate's life; `attempts` counts this boot's.
  const [attempt, setAttempt] = useState(1)
  const [attempts, setAttempts] = useState(1)
  // A failure was shown during this boot, which keeps the lockup finished.
  const [failedThisBoot, setFailedThisBoot] = useState(false)
  const [phase, setPhase] = useState<Phase>(splashed ? "connecting" : "ready")
  const [failure, setFailure] = useState<ConnectFailure | null>(null)
  // Failures in a row since the last success or "Retry now", which pace auto-retry.
  const [failures, setFailures] = useState(0)
  const [retryAt, setRetryAt] = useState<number | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const [boot, setBoot] = useState<BootProgress | null>(null)
  const [lift, setLift] = useState<Lift>("up")
  const [quit, setQuit] = useState(false)

  const retry = (fresh: boolean): void => {
    if (fresh) setFailures(0)
    setFailure(null)
    setRetryAt(undefined)
    setPhase("connecting")
    setAttempt((count) => count + 1)
    setAttempts((count) => count + 1)
  }
  const fail = (next: ConnectFailure): void => {
    setFailedThisBoot(true)
    const count = failures + 1
    const delay = autoRetryDelay(next, count)
    setFailures(count)
    setFailure(next)
    setNow(Date.now())
    setRetryAt(delay === undefined ? undefined : Date.now() + delay)
  }

  // The debug panel can ask for a fresh boot: the workspace goes and the splash runs
  // the start again, as on launch, without reloading the page.
  const reboots = "connect" in initial ? initial.reboots : undefined
  const reboot = useEffectEvent(() => {
    setFailures(0)
    setFailure(null)
    setRetryAt(undefined)
    setBoot(null)
    setLift("up")
    setPhase("connecting")
    setFailedThisBoot(false)
    setAttempt((count) => count + 1)
    setAttempts(1)
  })
  useEffect(() => reboots?.subscribe(reboot), [reboots])

  // Counts down to the next automatic retry, then takes it.
  const retryEvent = useEffectEvent(() => retry(false))
  useEffect(() => {
    if (retryAt === undefined) return
    const tick = setInterval(() => setNow(Date.now()), 250)
    const timer = setTimeout(retryEvent, Math.max(0, retryAt - Date.now()))
    return () => {
      clearInterval(tick)
      clearTimeout(timer)
    }
  }, [retryAt])

  // Once attached, the splash says so briefly, then fades into the workspace.
  const attached = Boolean(boot?.done)
  useEffect(() => {
    if (!attached) return
    const timers = [
      setTimeout(() => setLift("online"), 0),
      setTimeout(() => setLift("leaving"), onlineHoldMs),
      setTimeout(() => setLift("gone"), onlineHoldMs + splashFadeMs),
    ]
    return () => timers.forEach(clearTimeout)
  }, [attached])

  if (quit) return null
  const stage = stageOf(phase, boot, lift)
  return (
    <>
      <Attempt
        key={attempt}
        selection={initial}
        render={(createBackend) => render(createBackend, splashed ? setBoot : ignore)}
        onPhase={(next) => {
          setPhase(next)
          if (next === "ready") setFailures(0)
        }}
        onFailed={fail}
      />
      {splashed && lift !== "gone" && (
        <BootSplash
          line={bootLine(stage)}
          fill={bootFill(stage)}
          leaving={lift === "leaving"}
          settled={failedThisBoot}
          failure={
            failure && (
              <BootFailure
                failure={failure}
                attempts={attempts}
                retryIn={retryAt === undefined ? undefined : retryAt - now}
                onRetry={() => retry(true)}
                onQuit={() => {
                  // The desktop app closes; a browser tab may refuse, so the page empties.
                  window.close()
                  setQuit(true)
                }}
              />
            )
          }
        />
      )}
    </>
  )
}
