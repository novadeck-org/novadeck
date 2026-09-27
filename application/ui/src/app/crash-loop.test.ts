import { createStore } from "../model/store"
import { describe, expect, it } from "../test"
import { openCommands } from "../test/commands"
import { keyState } from "./commands/keys"

const crashLoop = (count: number) => ({ crashes: createStore(count), retry: () => {} })

describe("crash loop episodes", () => {
  it("forget Not now once the crash loop ends, so the next one asks again", () => {
    const backend = crashLoop(4)
    const app = openCommands({ crashLoop: backend })
    app.commands.dismissCrashLoop()
    backend.crashes.update(() => 5)
    expect(app.ui.getSnapshot().crashLoopDismissed).toBe(true)
    backend.crashes.update(() => 0)
    expect(app.ui.getSnapshot().crashLoopDismissed).toBe(false)
  })
})

describe("the crash-loop dialog and the keyboard", () => {
  it("holds shortcuts back while the dialog asks, and lets them through after Not now", () => {
    const backend = crashLoop(0)
    const app = openCommands({ crashLoop: backend })
    expect(keyState(app.context, app.commands).alert).toBe(false)
    backend.crashes.update(() => 4)
    expect(keyState(app.context, app.commands).alert).toBe(true)
    app.commands.dismissCrashLoop()
    expect(keyState(app.context, app.commands).alert).toBe(false)
  })
})
