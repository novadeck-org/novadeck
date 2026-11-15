import { forgeTitles, type ForgeName } from "@novadeck/core/forges"
import type { Backend } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { stepInstall } from "../preferences/installs"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { sameTerminals, terminalsOf } from "./useInstalls"

// A forge's command running in a terminal of its own: its tool's installer (`host` absent), or a
// host's sign-in.
type Run = {
  readonly forge: ForgeName
  readonly host: string | undefined
  readonly terminalId: string
  readonly ran: boolean
}

// The key a host's sign-in goes by in `signingIn`.
export const hostKey = (forge: ForgeName, host: string): string => `${forge}/${host}`

/**
 * Runs a forge's installer, or a host's sign-in command, in a new terminal, and once that
 * terminal ends looks again at the forges afresh, so the tool just installed or signed in
 * shows. A command that failed leaves its terminal as it is, for the person to read; the look
 * after it simply finds nothing new.
 */
export const useForgeRuns = (
  forges: Backend["forges"],
): {
  readonly install: (forge: ForgeName, command: string) => void
  readonly signIn: (forge: ForgeName, host: string, command: string) => void
  // The forges whose installer runs now.
  readonly installing: ReadonlySet<ForgeName>
  // The hosts whose sign-in runs now, as `hostKey`.
  readonly signingIn: ReadonlySet<string>
} => {
  const { commands } = useWorkspaceServices()
  const [runs] = useState(() => createStore<readonly Run[]>([]))
  const pending = useSyncExternalStore(runs.subscribe, runs.getSnapshot)
  const ids = pending.map((run) => run.terminalId)
  const terminals = useWorkspaceState((state) => terminalsOf(state, ids), sameTerminals)
  // The look that follows an end, once per run.
  const looked = useRef(new Set<string>())

  const start = useCallback(
    (forge: ForgeName, host: string | undefined, title: string, command: string) => {
      const terminalId = commands.add({ title, command })
      runs.update((current) => [...current, { forge, host, terminalId, ran: false }])
    },
    [commands, runs],
  )
  const install = useCallback(
    (forge: ForgeName, command: string) =>
      start(forge, undefined, `Install ${forgeTitles[forge]} CLI`, command),
    [start],
  )
  const signIn = useCallback(
    (forge: ForgeName, host: string, command: string) =>
      start(forge, host, `Sign in to ${host}`, command),
    [start],
  )

  useEffect(() => {
    if (pending.length === 0) return
    const next: Run[] = []
    let changed = false
    for (const run of pending) {
      const result = stepInstall(run, terminals.get(run.terminalId))
      if (result.step === "running") {
        next.push(result.install)
        changed ||= result.install !== run
        continue
      }
      changed = true
      if (result.step === "finished" && !looked.current.has(run.terminalId)) {
        looked.current.add(run.terminalId)
        void forges?.refresh({ fresh: true })
      }
    }
    if (changed) runs.update(() => next)
  }, [pending, terminals, forges, runs])

  const installing = useMemo(
    () => new Set(pending.filter((run) => run.host === undefined).map((run) => run.forge)),
    [pending],
  )
  const signingIn = useMemo(
    () =>
      new Set(
        pending.flatMap((run) => (run.host === undefined ? [] : [hostKey(run.forge, run.host)])),
      ),
    [pending],
  )
  return useMemo(
    () => ({ install, signIn, installing, signingIn }),
    [install, signIn, installing, signingIn],
  )
}
