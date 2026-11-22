import type { RunnerSettingsState } from "@novadeck/protocol"

import { context, describe, expect, it } from "./test"
import { scripted } from "./testing/scripted"

// The runner's settings as another device left them.
const settings = (changed: Partial<RunnerSettingsState> = {}): RunnerSettingsState => ({
  transcripts: true,
  transcriptsAvailable: true,
  welcomed: false,
  inboxOrder: [],
  inboxSnoozed: [],
  inboxHistory: [],
  hibernateAfterMinutes: 60,
  agentModes: false,
  agentMode: "herd",
  shippingGate: false,
  worktrees: false,
  ...changed,
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("following another device", () => {
  context("when the runner tells of its settings as they change", () => {
    it("shows each switch as another device left it", async () => {
      const app = scripted({ shown: [], follows: true, inboxOrder: [], inboxSnoozed: [] })
      app.settingsChanges.push(
        settings({
          agentModes: true,
          agentMode: "solo",
          hibernateAfterMinutes: null,
          welcomed: true,
        }),
      )
      await settled()
      expect(app.backend.agentModes!.enabled.getSnapshot()).toBe(true)
      expect(app.backend.agentMode!.mode.getSnapshot()).toBe("solo")
      expect(app.backend.hibernation!.after.getSnapshot()).toBeNull()
      expect(app.backend.agents!.welcome.getSnapshot()).toBe(false)
      expect(app.backend.inbox!.order!.getSnapshot()).toEqual([])
      app.settingsChanges.push(settings({ inboxOrder: ["a@1", "b@2"] }))
      await settled()
      expect(app.backend.inbox!.order!.getSnapshot()).toEqual(["a@1", "b@2"])
      app.stop()
    })

    it("keeps a change of this device's own under way until the runner answers it", async () => {
      let answer: () => void = () => {}
      const app = scripted({
        shown: [],
        follows: true,
        saveSettings: () => new Promise<void>((resolve) => (answer = resolve)),
      })
      app.backend.agentMode!.set("swarm")
      app.settingsChanges.push(settings({ agentMode: "herd" }))
      await settled()
      expect(app.backend.agentMode!.mode.getSnapshot()).toBe("swarm")
      answer()
      await settled()
      app.settingsChanges.push(settings({ agentMode: "swarm" }))
      await settled()
      expect(app.backend.agentMode!.mode.getSnapshot()).toBe("swarm")
      app.stop()
    })
  })

  context("with the person's preferences", () => {
    it("tells every value first, then others' changes, never this device's own", async () => {
      const app = scripted({ shown: [], follows: true })
      const heard: [Record<string, string | null>, boolean][] = []
      const stop = app.backend.preferences!.subscribe((values, first) =>
        heard.push([{ ...values }, first]),
      )
      app.preferenceChanges.push({ values: { appearance: '"dusk"' }, revision: 1, writer: null })
      await settled()
      app.backend.preferences!.set("chat-view", "true")
      await settled()
      const writer = (app.of("preference") as [string, string, string][])[0]?.[2] ?? ""
      app.preferenceChanges.push({ values: { "chat-view": "true" }, revision: 2, writer })
      app.preferenceChanges.push({ values: { appearance: '"noon"' }, revision: 3, writer: "other" })
      await settled()
      expect(heard).toEqual([
        [{ appearance: '"dusk"' }, true],
        [{ appearance: '"noon"' }, false],
      ])
      // One that subscribes later hears every value at once.
      const later: Record<string, string | null>[] = []
      app.backend.preferences!.subscribe((values) => later.push({ ...values }))
      expect(later).toEqual([{ appearance: '"noon"', "chat-view": "true" }])
      stop()
      app.stop()
    })

    it("offers none where the runner keeps none", () => {
      const app = scripted({ shown: [] })
      expect(app.backend.preferences).toBeUndefined()
      app.stop()
    })
  })
})
