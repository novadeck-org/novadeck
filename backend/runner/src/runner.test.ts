import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { vi } from "vitest"

import { createRunner } from "./index.js"
import { Murmur } from "./murmur/service.js"
import { describe, expect, it } from "./test.js"
import { ptyOptions } from "./testing/pty.js"
import { Voice } from "./voice/service.js"
import { WorkspaceStore } from "./workspaces/store.js"

describe("a runner that can't be built", () => {
  it("ends what it started and closes its store", async ({ resources }) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-runner-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const closes = [
      vi.spyOn(Voice.prototype, "close"),
      vi.spyOn(Murmur.prototype, "close"),
      vi.spyOn(WorkspaceStore.prototype, "close"),
    ]
    resources.defer(() => closes.forEach((spy) => spy.mockRestore()))
    expect(() =>
      createRunner({
        database: join(root, "workspace.sqlite"),
        terminals: { maxRetained: 0 },
        // No login shell, and no home but the scratch one.
        agents: { login: false, home: root, env: { PATH: process.env.PATH, HOME: root } },
      }),
    ).toThrow(RangeError)
    await vi.waitFor(() => {
      for (const spy of closes) expect(spy).toHaveBeenCalledOnce()
    })
  })
})

describe("a runner started on a workspace from before agent worktrees left Experimental", () => {
  it("turns them on once, and keeps an off the person chooses after", async ({ resources }) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-runner-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const database = join(root, "workspace.sqlite")
    const options = {
      database,
      terminals: { ...ptyOptions },
      // No login shell, and no home but the scratch one.
      agents: { login: false, home: root, env: { PATH: process.env.PATH, HOME: root } },
    }
    const saved = (): boolean => {
      const store = new WorkspaceStore(database)
      try {
        return store.settings.runner().worktrees
      } finally {
        store.close()
      }
    }
    // A stable launch saved them off.
    const earlier = new WorkspaceStore(database)
    earlier.settings.saveRunner({ worktrees: false })
    earlier.close()

    await createRunner(options).close()
    expect(saved()).toBe(true)

    const chosen = new WorkspaceStore(database)
    chosen.settings.saveRunner({ worktrees: false })
    chosen.close()
    await createRunner(options).close()
    expect(saved()).toBe(false)
  })
})
