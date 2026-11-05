import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { vi } from "vitest"

import { createRunner } from "./index.js"
import { Murmur } from "./murmur/service.js"
import { describe, expect, it } from "./test.js"
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
      createRunner({ database: join(root, "workspace.sqlite"), terminals: { maxRetained: 0 } }),
    ).toThrow(RangeError)
    await vi.waitFor(() => {
      for (const spy of closes) expect(spy).toHaveBeenCalledOnce()
    })
  })
})
