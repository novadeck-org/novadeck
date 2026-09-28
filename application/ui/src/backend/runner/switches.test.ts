import { RunnerError } from "@novadeck/protocol/client"

import { describe, expect, it } from "../../test"
import { scripted } from "./scripted"

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

  it("goes back when the runner could not change it", async () => {
    const app = scripted({
      shown: [],
      saveSettings: () => Promise.reject(new RunnerError("DISCONNECTED")),
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
        Promise.reject(new RunnerError("AGENT_SETUP_FAILED", "claude plugin install failed")),
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

  it("offer onboarding until it is done, which the runner remembers", async () => {
    const app = scripted({ shown: [] })
    const agents = app.backend.agents!
    expect(agents.onboarding.getSnapshot()).toBe(true)
    agents.finishOnboarding()
    expect(agents.onboarding.getSnapshot()).toBe(false)
    await app.idle()
    expect(app.of("settings")).toEqual([{ onboarded: true }])
    app.stop()
  })
})
