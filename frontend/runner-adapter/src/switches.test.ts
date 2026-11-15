import { maxSnoozes } from "@novadeck/core/inbox"
import { maxInboxOrder } from "@novadeck/protocol"
import type { ForgeIntegration } from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"

import { describe, expect, it } from "./test"
import { scripted } from "./testing/scripted"

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

describe("the idle agents setting", () => {
  it("shows what the runner said, and changes it there", async () => {
    const app = scripted({ shown: [] })
    const hibernation = app.backend.hibernation!
    expect(hibernation.after.getSnapshot()).toBe(60)
    hibernation.set(null)
    expect(hibernation.after.getSnapshot()).toBeNull()
    hibernation.set(240)
    await app.idle()
    expect(hibernation.after.getSnapshot()).toBe(240)
    expect(app.of("settings")).toEqual([
      { hibernateAfterMinutes: null },
      { hibernateAfterMinutes: 240 },
    ])
    app.stop()
  })

  it("goes back when the runner could not change it", async () => {
    const app = scripted({
      shown: [],
      saveSettings: () => Promise.reject(new WireError("DISCONNECTED")),
    })
    const { after, set } = app.backend.hibernation!
    set(15)
    expect(after.getSnapshot()).toBe(15)
    await app.idle()
    expect(after.getSnapshot()).toBe(60)
    app.stop()
  })
})

describe("the agent worktrees setting", () => {
  it("shows what the runner said, and changes it there", async () => {
    const app = scripted({ shown: [] })
    const worktrees = app.backend.worktrees!
    expect(worktrees.enabled.getSnapshot()).toBe(false)
    worktrees.set(true)
    expect(worktrees.enabled.getSnapshot()).toBe(true)
    await app.idle()
    expect(app.of("settings")).toEqual([{ worktrees: true }])
    app.stop()
  })

  it("goes back when the runner could not change it", async () => {
    const app = scripted({
      shown: [],
      saveSettings: () => Promise.reject(new WireError("DISCONNECTED")),
    })
    const { enabled, set } = app.backend.worktrees!
    set(true)
    expect(enabled.getSnapshot()).toBe(true)
    await app.idle()
    expect(enabled.getSnapshot()).toBe(false)
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

  it("look again at the agents, and say when what the runner found is shown", async () => {
    const installer = "curl -fsSL https://antigravity.google/cli/install.sh | bash"
    let found = [
      { agent: "claude", available: true, connected: false },
      { agent: "agy", available: false, connected: false, installer },
    ]
    const app = scripted({ shown: [], listAgents: async () => found })
    const agents = app.backend.agents!
    // What the runner said at startup, with the command that installs what is missing.
    await agents.refresh()
    expect(agents.state.getSnapshot()[1]).toEqual({
      agent: "agy",
      available: false,
      connected: false,
      installer,
      busy: false,
    })
    // Installed since: the runner's list no longer names an installer.
    found = [
      { agent: "claude", available: true, connected: false },
      { agent: "agy", available: true, connected: false },
    ]
    await agents.refresh()
    expect(agents.state.getSnapshot()[1]).toEqual({
      agent: "agy",
      available: true,
      connected: false,
      busy: false,
    })
    app.stop()
  })

  it("asks for a fresh look only when told to", async () => {
    const asked: unknown[] = []
    const app = scripted({
      shown: [],
      listAgents: async (options) => {
        asked.push(options)
        return []
      },
    })
    const agents = app.backend.agents!
    await agents.refresh()
    await agents.refresh({ fresh: true })
    expect(asked).toEqual([undefined, { fresh: true }])
    app.stop()
  })

  it("keep what is shown when the runner cannot be asked again", async () => {
    const app = scripted({
      shown: [],
      listAgents: () => Promise.reject(new WireError("DISCONNECTED")),
    })
    const agents = app.backend.agents!
    await expect(agents.refresh()).resolves.toBeUndefined()
    expect(agents.state.getSnapshot()[1]).toMatchObject({ agent: "agy", available: false })
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

describe("the forge switches", () => {
  const github: ForgeIntegration = {
    forge: "github",
    available: true,
    enabled: false,
    hosts: [],
  }

  it("are not offered by a runner that said nothing of forges", () => {
    const app = scripted({ shown: [] })
    expect(app.backend.forges).toBeUndefined()
    app.stop()
  })

  it("switch a forge through the runner, busy until it answers", async () => {
    const app = scripted({
      shown: [],
      forges: [github],
      switchForge: async (forge, enabled) => ({
        ...github,
        forge,
        enabled,
        hosts: [{ host: "github.com", state: "signed-in" }],
      }),
    })
    const forges = app.backend.forges!
    expect(forges.state.getSnapshot()).toEqual([{ ...github, busy: false }])
    forges.set("github", true)
    expect(forges.state.getSnapshot()[0]).toMatchObject({
      busy: true,
      enabled: false,
    })
    await app.idle()
    expect(app.of("forges")).toEqual([["github", true]])
    expect(forges.state.getSnapshot()[0]).toEqual({
      ...github,
      enabled: true,
      hosts: [{ host: "github.com", state: "signed-in" }],
      busy: false,
    })
    app.stop()
  })

  it("say why a forge could not be switched, and leave it as it was", async () => {
    const app = scripted({
      shown: [],
      forges: [github],
      switchForge: () => Promise.reject(new WireError("DISCONNECTED")),
    })
    const forges = app.backend.forges!
    forges.set("github", true)
    await app.idle()
    const [shown] = forges.state.getSnapshot()
    expect(shown).toMatchObject({ enabled: false, busy: false })
    expect(shown?.error).toBeTypeOf("string")
    app.stop()
  })

  it("look again at the forges, asking afresh when told to", async () => {
    const asked: (boolean | undefined)[] = []
    const installer = "brew install gh"
    const app = scripted({
      shown: [],
      forges: [{ ...github, available: false, installer }],
      listForges: async (options) => {
        asked.push(options?.fresh)
        return [github]
      },
    })
    const forges = app.backend.forges!
    await forges.refresh({ fresh: true })
    expect(asked).toEqual([true])
    expect(forges.state.getSnapshot()).toEqual([{ ...github, busy: false }])
    app.stop()
  })

  it("never let a list asked before a switch undo it", async () => {
    let answer: (list: ForgeIntegration[]) => void = () => {}
    const app = scripted({
      shown: [],
      forges: [{ ...github, enabled: true }],
      // The list waits on a slow tool; the switch answers at once.
      listForges: () =>
        new Promise((resolve) => {
          answer = resolve
        }),
      switchForge: async (forge, enabled) => ({ ...github, forge, enabled }),
    })
    const forges = app.backend.forges!
    const listed = forges.refresh()
    forges.set("github", false)
    await Promise.resolve()
    await Promise.resolve()
    expect(forges.state.getSnapshot()[0]).toMatchObject({ enabled: false, busy: false })
    // What the runner said before the switch lands last.
    answer([{ ...github, enabled: true }])
    await listed
    expect(forges.state.getSnapshot()[0]).toMatchObject({ enabled: false, busy: false })
    // A list asked after it is shown.
    const later = forges.refresh()
    answer([{ ...github, enabled: false, hosts: [{ host: "github.com", state: "signed-in" }] }])
    await later
    expect(forges.state.getSnapshot()[0]?.hosts).toEqual([
      { host: "github.com", state: "signed-in" },
    ])
    app.stop()
  })
})
