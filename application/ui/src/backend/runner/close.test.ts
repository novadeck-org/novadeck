import { pause } from "@novadeck/terminal/view"
import { WireError } from "@novadeck/wire"
import type { WireStatus } from "@novadeck/wire/client"

import { workspaceFromSeed } from "#core/seed"
import { activeProject, activeSession, workspaceReducer } from "#core/state"
import type { WorkspaceAction } from "#core/state"

import { describe, expect, it } from "../../test"
import { noTheme } from "../terminal-views/theme"
import { runnerBackend, type RunnerApi } from "./backend"
import { noCompanions } from "./scripted"
import type { RunnerListing } from "./seed"

// A terminal watch that never reports anything.
const nothing = (): AsyncIterableIterator<never, undefined> => {
  const iterator: AsyncIterableIterator<never, undefined> = {
    [Symbol.asyncIterator]: () => iterator,
    next: () => new Promise(() => {}),
    return: async () => ({ done: true, value: undefined }),
  }
  return iterator
}

// A runner whose link drops right after it started a shell, before it could answer:
// a situation a real runner cannot be put in on cue.
const droppingRunner = () => {
  let status: WireStatus = { state: "connected", epoch: "r1" }
  const wake = new Set<() => void>()
  const set = (next: WireStatus): void => {
    status = next
    for (const resolve of wake) resolve()
    wake.clear()
  }
  const statuses = async function* (): AsyncGenerator<WireStatus, undefined> {
    let last: WireStatus | undefined
    for (;;) {
      if (status !== last) {
        last = status
        yield status
      }
      // eslint-disable-next-line no-await-in-loop -- Waits for the next change.
      await new Promise<void>((resolve) => wake.add(resolve))
    }
  }
  const shells = new Set<string>()
  const api = {
    watch: statuses,
    projects: { list: async () => [], create: async () => ({}), rename: async () => ({}) },
    sessions: {
      list: async () => [],
      create: async () => ({}),
      rename: async () => ({}),
      save: async () => {},
    },
    terminals: {
      list: async () => [],
      watch: nothing,
      requests: nothing,
      create: async (input: { readonly id: string }) => {
        if (shells.has(input.id)) throw new WireError("CONFLICT", "taken")
        shells.add(input.id)
        set({ state: "reconnecting", error: new WireError("DISCONNECTED") })
        throw new WireError("DISCONNECTED", "lost")
      },
      close: async (id: string) => void shells.delete(id),
      restart: async () => {
        throw new Error("not used here")
      },
      attach: () => new Promise(() => {}),
    },
    companions: noCompanions,
  } as unknown as RunnerApi
  return { api, shells, reconnect: () => set({ state: "connected", epoch: "r1" }) }
}

describe("closing a terminal while its create is unanswered", () => {
  it("still ends the shell the runner started", async () => {
    const runner = droppingRunner()
    const listing: RunnerListing = [
      {
        project: { id: "p", name: "P", cwd: "/tmp" },
        sessions: [{ session: { id: "s", projectId: "p", name: "S", state: null }, terminals: [] }],
      },
    ]
    const { backend } = runnerBackend(runner.api, listing, { theme: noTheme, saveDelay: 10 })
    let workspace = workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 1 })
    backend.commit(workspace, [])
    const stop = backend.start!({ dispatch: () => {}, open: () => {} })
    const commit = (actions: WorkspaceAction[]): void => {
      workspace = actions.reduce(workspaceReducer, workspace)
      backend.commit(workspace, actions)
    }
    const target = {
      projectId: activeProject(workspace)!.id,
      workspaceSessionId: activeSession(workspace)!.id,
    }
    const terminal = backend.newTerminal({ target, directory: "/tmp" })
    commit([{ type: "terminal/add", target, terminal }])
    await pause(50)
    commit([{ type: "terminal/close", target, terminalId: terminal.id }])
    await pause(700)
    runner.reconnect()
    await pause(1_500)
    expect([...runner.shells]).toEqual([])
    stop()
  }, 10_000)
})
