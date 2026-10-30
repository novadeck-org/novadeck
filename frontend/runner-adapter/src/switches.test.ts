import { maxSnoozes } from "@novadeck/core/inbox"
import { maxInboxOrder } from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"

import { scripted } from "./scripted"
import { describe, expect, it } from "./test"

describe("the transcript setting", () => {
  it("shows what the runner said, and changes it there", async () => {
    const app = scripted({ shown: [] })
    const transcripts = app.backend.transcripts!
    expect(transcripts.enabled.getSnapshot()).toBe(true)
    transcripts.set(false)
    expect(transcripts.enabled.getSnapshot()).toBe(false)
    await app.idle()
    expect(app.of("settings")).toEqual([{ transcripts: false }])
    app.stop()
  })

  it("is available unless the runner said it cannot keep them encrypted", () => {
    const kept = scripted({ shown: [] })
    expect(kept.backend.transcripts!.available).toBe(true)
    kept.stop()
    const unkept = scripted({ shown: [], transcriptsAvailable: false })
    expect(unkept.backend.transcripts!.available).toBe(false)
    unkept.stop()
  })

  it("goes back when the runner could not change it", async () => {
    const app = scripted({
      shown: [],
      saveSettings: () => Promise.reject(new WireError("DISCONNECTED")),
    })
    const transcripts = app.backend.transcripts!
    transcripts.set(false)
    await app.idle()
    expect(transcripts.enabled.getSnapshot()).toBe(true)
    app.stop()
  })
})

describe("the agent switches", () => {
  it("connect an agent through the runner, busy until it answers", async () => {
    const app = scripted({ shown: [] })
    const agents = app.backend.agents!
    agents.set("claude", true)
    expect(agents.state.getSnapshot()[0]).toMatchObject({ busy: true, connected: false })
    await app.idle()
    expect(app.of("agents")).toEqual([["claude", true]])
    expect(agents.state.getSnapshot()[0]).toEqual({
      agent: "claude",
      available: true,
      connected: true,
      busy: false,
    })
    app.stop()
  })

  it("say why an agent could not be connected, and leave it as it was", async () => {
    const app = scripted({
      shown: [],
      connect: () =>
        Promise.reject(new WireError("AGENT_SETUP_FAILED", "claude plugin install failed")),
    })
    const agents = app.backend.agents!
    agents.set("claude", true)
    await app.idle()
    expect(agents.state.getSnapshot()[0]).toMatchObject({
      connected: false,
      busy: false,
      error: "claude plugin install failed",
    })
    app.stop()
  })

  it("offer the welcome dialog until it is done, which the runner remembers", async () => {
    const app = scripted({ shown: [] })
    const agents = app.backend.agents!
    expect(agents.welcome.getSnapshot()).toBe(true)
    agents.finishWelcome()
    expect(agents.welcome.getSnapshot()).toBe(false)
    await app.idle()
    expect(app.of("settings")).toEqual([{ welcomed: true }])
    app.stop()
  })
})

describe("the Inbox's order and snoozes", () => {
  it("show what the runner kept, and keep each change there, as many as it takes", async () => {
    const app = scripted({ shown: [], inboxOrder: ["b@2", "a@1"], inboxSnoozed: ["a@1", "b@2"] })
    const inbox = app.backend.inbox!
    expect(inbox.order?.getSnapshot()).toEqual(["b@2", "a@1"])
    // No row is listed here: those not listed are kept while there is room, as one may be
    // back; past it, the latest placed stay.
    inbox.arrange?.(["a@1", "b@2"])
    expect(inbox.order?.getSnapshot()).toEqual(["a@1", "b@2"])
    const many = Array.from({ length: maxInboxOrder + 5 }, (_, index) => `r${index}@1`)
    inbox.arrange?.(many)
    expect(inbox.order?.getSnapshot()).toEqual(many.slice(5))
    inbox.snooze?.("a", false)
    await app.idle()
    expect(app.of("settings")).toEqual([
      { inboxOrder: ["a@1", "b@2"] },
      { inboxOrder: many.slice(5) },
      { inboxSnoozed: ["b@2"] },
    ])
    app.stop()
  })

  it("keep as many snoozes as the runner takes", () => {
    expect(maxSnoozes).toBe(maxInboxOrder)
  })

  it("aren't offered where the runner keeps none", () => {
    const app = scripted({ shown: [] })
    expect(app.backend.inbox?.arrange).toBeUndefined()
    expect(app.backend.inbox?.snooze).toBeUndefined()
    app.stop()
  })
})
