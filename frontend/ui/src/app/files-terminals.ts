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

// Follows the command run in the terminal `id`, begun at `since`, from the moment it is made until
// it is over (so it keeps its time while no card shows it): running until its program has run and
// left its shell, or the terminal ended. Then `finished`, which says nothing of whether it worked:
// the roster tells no exit status of a program in a living shell. Only a terminal that failed, went
// or exited with a status is `failed`. The time is that of the change that showed it over; a
// command never seen running (one quick enough to end between two reads) is `finished` once its
// shell has sat at the prompt for `settleMs`, with no time.
export const followTerminal = (
  workspace: Pick<WorkspaceStore, "getSnapshot" | "subscribe">,
  id: string,
  since: number,
  now: () => number = Date.now,
): TerminalFollower => {
  let sawBusy = false
  let progress: TerminalProgress = { phase: "running" }
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  const end = (phase: "finished" | "failed", ms?: number): void => {
    progress = { phase, ...(ms !== undefined && { ms }) }
    clearTimeout(timer)
    stop?.()
    stop = undefined
    for (const listener of listeners) listener()
  }
  const look = (): void => {
    if (progress.phase !== "running") return
    const standing = standingOf(workspace.getSnapshot(), id)
    // Whatever the shell showed, a program running now ends the wait for one.
    if (standing !== "quiet") {
      clearTimeout(timer)
      timer = undefined
    }
    if (standing === "busy") sawBusy = true
    else if (standing === "ended") end("finished", now() - since)
    else if (standing === "failed" || standing === "gone") end("failed", now() - since)
    else if (standing === "quiet" && sawBusy) end("finished", now() - since)
    else if (standing === "quiet" && timer === undefined)
      timer = setTimeout(() => end("finished"), Math.max(0, since + settleMs - now()))
  }
  stop = workspace.subscribe(look)
  look()
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    get: () => progress,
  }
}
