import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, vi } from "vitest"

import { workspaceFromSeed } from "../../model/seed"
import { activeProject, activeSession, workspaceReducer } from "../../model/state"
import type { WorkspaceAction } from "../../model/state"
import { describe, expect, it } from "../../test"
import { runnerBackend } from "./backend"
import { startTestRunner } from "./testing"

vi.setConfig({ testTimeout: 20_000 })

const directory = mkdtempSync(join(tmpdir(), "novadeck-quit-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

// One launch of the app on a database, with the host's quit: the page finishes what it
// holds, then the runner stops.
const launch = async (database: string) => {
  const runner = await startTestRunner({ database })
  let finish: (() => Promise<void>) | undefined
  const { backend, idle } = runnerBackend(runner.client, runner.listing, {
    saveDelay: 10,
    beforeQuit: (save) => {
      finish = save
      return () => {}
    },
  })
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
  return {
    target,
    backend,
    // Resolves once the runner has every terminal asked for and the saves are done.
    idle,
    commit,
    terminals: () => activeSession(workspace)!.state.roster.terminals.map(({ id }) => id),
    listed: () => runner.listing.flatMap(({ sessions }) => sessions.flatMap((s) => s.terminals)),
    quit: async (during?: () => void) => {
      const finished = finish?.()
      during?.()
      await finished
      stop()
      await runner.close()
    },
  }
}

describe("closing a terminal right before the app quits", () => {
  it("leaves it closed at the next launch", async () => {
    const database = join(directory, "fresh.sqlite")
    const first = await launch(database)
    const kept = first.backend.newTerminal({ target: first.target, directory })
    const closed = first.backend.newTerminal({ target: first.target, directory })
    first.commit([{ type: "terminal/add", target: first.target, terminal: kept }])
    first.commit([{ type: "terminal/add", target: first.target, terminal: closed }])
    await first.idle()

    first.commit([{ type: "terminal/close", target: first.target, terminalId: closed.id }])
    await first.quit()

    const second = await launch(database)
    expect(second.listed().map(({ id }) => id)).toEqual([kept.id])
    await second.quit()
  })

  it("leaves one closed while the quit waits closed too", async () => {
    const database = join(directory, "during.sqlite")
    const first = await launch(database)
    const added = [0, 1, 2].map(() =>
      first.backend.newTerminal({ target: first.target, directory }),
    )
    for (const terminal of added)
      first.commit([{ type: "terminal/add", target: first.target, terminal }])
    await first.idle()

    first.commit([{ type: "terminal/close", target: first.target, terminalId: added[0]!.id }])
    await first.quit(() =>
      first.commit([{ type: "terminal/close", target: first.target, terminalId: added[1]!.id }]),
    )

    const second = await launch(database)
    expect(second.listed().map(({ id }) => id)).toEqual([added[2]!.id])
    await second.quit()
  })

  it("leaves a terminal restored from the last launch closed too", async () => {
    const database = join(directory, "restored.sqlite")
    const first = await launch(database)
    for (let count = 0; count < 2; count += 1)
      first.commit([
        {
          type: "terminal/add",
          target: first.target,
          terminal: first.backend.newTerminal({ target: first.target, directory }),
        },
      ])
    await first.idle()
    await first.quit()

    const second = await launch(database)
    const [closed, kept] = second.terminals()
    second.commit([{ type: "terminal/close", target: second.target, terminalId: closed! }])
    await second.quit()

    const third = await launch(database)
    expect(third.listed().map(({ id }) => id)).toEqual([kept])
    await third.quit()
  })
})
