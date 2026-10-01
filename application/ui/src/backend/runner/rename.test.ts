import { vi } from "vitest"

import { workspaceFromSeed } from "../../model/seed"
import { describe, expect, it } from "../../test"
import { id, scripted } from "./scripted"

describe("renaming a terminal", () => {
  it("reaches the runner for one with no shell, as one kept off screen", async () => {
    // Its session isn't on screen and it has no program to resume: no shell starts.
    const app = scripted({ shown: [], background: [{ id: id(2), lastProcess: "" }] })
    const workspace = workspaceFromSeed(app.backend.seed, {
      view: "grid",
      windowedView: "grid",
      now: 1,
    })
    const target = { projectId: "p", workspaceSessionId: id(9) }
    app.backend.commit(workspace, [
      { type: "terminal/rename", target, terminalId: id(2), name: "API" },
    ])
    await vi.waitFor(() => expect(app.of("rename")).toEqual([[id(2), "API"]]))
    expect(app.of("create")).toEqual([])
    app.stop()
  })
})
