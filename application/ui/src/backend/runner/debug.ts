import type { RunnerError } from "@novadeck/protocol/client"

import { createStore, type Store } from "../../model/store"
import type { BootRehearsal, BootRehearsals } from "../boot-rehearsal"

// What the next terminal create does instead of the usual: start in another
// directory, or fail with a code without reaching the runner.
export type CreateOverride = { readonly cwd?: string; readonly fail?: RunnerError["code"] }

// The debug panel's hooks into the runner adapter, in one place so the real code paths
// only ask it the two questions they need: what the next create should do, and
// whether an outage is being simulated.
export type RunnerDebug = {
  readonly rehearse: (rehearsal: BootRehearsal) => void
  readonly armCreate: (next: CreateOverride) => void
  // The armed override, handed out once.
  readonly takeCreate: () => CreateOverride
  // True while a simulated outage shows the connection as reconnecting.
  readonly outage: Store<boolean>
  readonly forceReconnecting: (ms: number) => void
  // Kills the runner process, where the desktop host offers it.
  readonly killRunner: (() => Promise<boolean>) | undefined
}

export const createRunnerDebug = ({
  rehearsals,
  killRunner,
}: {
  readonly rehearsals: BootRehearsals
  readonly killRunner?: (() => Promise<boolean>) | undefined
}): RunnerDebug => {
  let armed: CreateOverride = {}
  const outage = createStore(false)
  let outageTimer: ReturnType<typeof setTimeout> | undefined
  return {
    rehearse: rehearsals.rehearse,
    armCreate: (next) => {
      armed = next
    },
    takeCreate: () => {
      const next = armed
      armed = {}
      return next
    },
    outage,
    forceReconnecting: (ms) => {
      clearTimeout(outageTimer)
      outage.update(() => true)
      outageTimer = setTimeout(() => outage.update(() => false), ms)
    },
    killRunner,
  }
}
