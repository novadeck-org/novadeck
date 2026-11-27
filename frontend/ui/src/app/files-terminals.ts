import type { WorkspaceStore } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import type { TerminalFollower, TerminalProgress } from "../sidebar/files-sync"

// What the Files card follows of a terminal it opened to run a command in: how it stands, in the
// few words the roster tells (a program runs in its shell, or none, or the terminal has ended).
export type TerminalStanding = "starting" | "busy" | "quiet" | "failed" | "ended" | "gone"

export const standingOf = (workspace: Workspace, id: string): TerminalStanding => {
  for (const project of workspace.projects)
    for (const session of project.history) {
      const terminal = session.state.roster.terminals.find((each) => each.id === id)
      if (!terminal) continue
      if (terminal.state === "failed") return "failed"
      if (terminal.state === "exited") return terminal.exitCode === 0 ? "ended" : "failed"
      if (terminal.state === "starting") return "starting"
      return terminal.busy === true ? "busy" : "quiet"
    }
  return "gone"
}

// How long a terminal may sit at its prompt, never having shown a program, before the command it
// was given is taken as done (a command quick enough to end between two reads).
export const settleMs = 8000

// Follows the command run in the terminal `id`, begun at `since`: running until its program has run
// and left its shell (or the terminal ended), then done, or failed where the terminal failed, went
// or exited with a status. The roster doesn't tell a program's own exit status while its shell goes
// on, so a finished command in a living shell reads as done. It listens only while something
// subscribes, and keeps where it got to between subscriptions.
export const followTerminal = (
  workspace: Pick<WorkspaceStore, "getSnapshot" | "subscribe">,
  id: string,
  since: number,
  now: () => number = Date.now,
): TerminalFollower => {
  let sawBusy = false
  let progress: TerminalProgress = { phase: "running", ms: 0 }
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  const end = (failed: boolean): void => {
    progress = { phase: failed ? "failed" : "done", ms: now() - since }
    clearTimeout(timer)
    for (const listener of listeners) listener()
  }
  const look = (): void => {
    if (progress.phase !== "running") return
    const standing = standingOf(workspace.getSnapshot(), id)
    if (standing === "busy") sawBusy = true
    else if (standing === "ended") end(false)
    else if (standing === "failed" || standing === "gone") end(true)
    else if (standing === "quiet" && sawBusy) end(false)
    else if (standing === "quiet") {
      clearTimeout(timer)
      timer = setTimeout(() => end(false), Math.max(0, since + settleMs - now()))
    }
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      if (listeners.size === 1) {
        stop = workspace.subscribe(look)
        look()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stop?.()
          stop = undefined
          clearTimeout(timer)
        }
      }
    },
    get: () => progress,
  }
}
