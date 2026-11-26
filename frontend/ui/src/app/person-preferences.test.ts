import { syncPerson } from "@novadeck/core/person"
import type { PersonPreferences } from "@novadeck/core/port"
import type { PreferencesValue } from "@novadeck/core/types"
import { afterEach } from "vitest"

import { preferencesFrom } from "../preferences/preferences-storage"
import { context, describe, expect, it } from "../test"
import { followPersonPreferences } from "./person-preferences"
import { createUiStore, initialUi, type UiStore } from "./ui-store"

const stops: (() => void)[] = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

const route = {
  projectId: "project",
  sessionId: "initial",
  view: "focus",
  terminal: "",
  panel: "terminals",
  dialog: null,
  section: "notifications",
} as const

// This device's UI, with its preferences, following a runner that holds `values`.
const device = (preferences: Partial<PreferencesValue>, values: Record<string, string>) => {
  const ui: UiStore = createUiStore(
    initialUi({
      location: { route, dialogDepth: 0, navigationType: "POP" },
      preferences: preferencesFrom(preferences),
    }),
  )
  const update = (next: PreferencesValue) => ui.update((state) => ({ ...state, preferences: next }))
  stops.push(followPersonPreferences(ui, update))
  const sent: [string, string | null][] = []
  let listener: Parameters<PersonPreferences["subscribe"]>[0] | undefined
  stops.push(
    syncPerson({
      set: (key, value) => void sent.push([key, value]),
      subscribe: (next) => {
        listener = next
        next(values, true)
        return () => (listener = undefined)
      },
    }),
  )
  return {
    ui,
    sent,
    update,
    other: (changed: Record<string, string | null>) => listener?.(changed, false),
    preferences: () => ui.getSnapshot().preferences,
  }
}

describe("preferences that follow the person", () => {
  context("as a device meets a runner that keeps them", () => {
    it("takes the person's, and keeps its own text, scale, sounds and notifications", () => {
      const phone = device(
        { fontSize: 18, appScale: 125, notifyFinished: false, sound: false, chatView: false },
        { "chat-view": "true", appearance: '{"theme":"nope","scheme":"dark"}' },
      )
      expect(phone.preferences()).toMatchObject({
        chatView: true,
        fontSize: 18,
        appScale: 125,
        notifyFinished: false,
        sound: false,
      })
      // A theme this build doesn't have reads as a saved one would: the default theme.
      expect(phone.preferences().appearance).toEqual(
        preferencesFrom({ appearance: { theme: "nope", scheme: "dark" } as never }).appearance,
      )
    })

    it("gives a runner that has none only what this device's person chose, never a default", () => {
      const desktop = device({ chatView: true, fontSize: 18 }, {})
      expect(desktop.sent).toEqual([["chat-view", "true"]])
    })

    it("gives nothing from a new device that connects first, so it resets no one's choices", () => {
      expect(device({}, {}).sent).toEqual([])
    })

    it("shows a value it can't read as its default, and never sends that back", () => {
      const older = device({}, { appearance: '{"theme":"from-a-newer-build","scheme":"dark"}' })
      expect(older.preferences().appearance.scheme).toBe("dark")
      expect(older.sent).toEqual([])
    })
  })

  context("once connected", () => {
    it("sends a change of a person's preference, and none of a device's", () => {
      const desktop = device({}, { "chat-view": "false" })
      desktop.update({ ...desktop.preferences(), chatView: true, fontSize: 20, notifyNeeds: false })
      // Back to the default: the person's choice is forgotten, as no choice.
      desktop.update({ ...desktop.preferences(), chatView: false })
      expect(desktop.sent).toEqual([
        ["chat-view", "true"],
        ["chat-view", null],
      ])
    })

    it("follows another device's change of a preference, and the Agent Chat offer once answered", () => {
      const phone = device({ chatView: false }, { "chat-view": "false" })
      phone.other({ "chat-view": "true", "agent-chat-offer-answered": "true" })
      expect(phone.preferences().chatView).toBe(true)
      expect(phone.ui.getSnapshot().chatOfferAnswered).toBe(true)
    })
  })
})
