import { afterEach } from "vitest"

import { registerPerson, savePerson, syncPerson, watchPerson, type PersonItem } from "./person"
import type { PersonPreferences } from "./port"
import { context, describe, expect, it } from "./test"

const stops: (() => void)[] = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

// A setting held in a variable, as a store would hold it.
const held = (key: string, text: string | undefined) => {
  let value = text
  const item: PersonItem = {
    key,
    read: () => value,
    write: (next) => (value = next ?? undefined),
  }
  stops.push(registerPerson(item))
  return {
    value: () => value,
    change: (next: string) => {
      value = next
      savePerson(key)
    },
  }
}

// A runner holding `values`, which records what is set and lets the test tell of others' changes.
const runner = (values: Record<string, string>) => {
  const sent: [string, string | null][] = []
  let listener: Parameters<PersonPreferences["subscribe"]>[0] | undefined
  const preferences: PersonPreferences = {
    set: (key, value) => void sent.push([key, value]),
    subscribe: (next) => {
      listener = next
      next(values, true)
      return () => (listener = undefined)
    },
  }
  stops.push(syncPerson(preferences))
  return { sent, other: (changed: Record<string, string | null>) => listener?.(changed, false) }
}

describe("the person's settings", () => {
  context("as this device first meets the runner", () => {
    it("takes the runner's values, and gives it this device's where it has none", () => {
      const theme = held("appearance", '"dusk"')
      const views = held("enabled-views", '["grid"]')
      const unsaved = held("chat-view", undefined)
      const { sent } = runner({ appearance: '"dawn"' })
      expect(theme.value()).toBe('"dawn"')
      // Seeded: the first device after an update gives the person's; nothing is reset.
      expect(sent).toEqual([["enabled-views", '["grid"]']])
      expect(views.value()).toBe('["grid"]')
      expect(unsaved.value()).toBeUndefined()
    })

    it("does the same for a setting that turns up after it", () => {
      const { sent } = runner({ "help-opened": "1" })
      const help = held("help-opened", undefined)
      const order = held("sidebar-order", '["files"]')
      expect(help.value()).toBe("1")
      expect(order.value()).toBe('["files"]')
      expect(sent).toEqual([["sidebar-order", '["files"]']])
    })
  })

  context("once connected", () => {
    it("sends each change made here once, and none the runner already has", () => {
      const theme = held("appearance", '"dusk"')
      const { sent } = runner({ appearance: '"dusk"' })
      theme.change('"noon"')
      theme.change('"noon"')
      expect(sent).toEqual([["appearance", '"noon"']])
    })

    it("takes another device's change, says so, and never sends it back", () => {
      const theme = held("appearance", '"dusk"')
      const told: string[] = []
      stops.push(watchPerson((key) => told.push(key)))
      const { sent, other } = runner({ appearance: '"dusk"' })
      other({ appearance: '"night"', "newer-setting": "1" })
      expect(theme.value()).toBe('"night"')
      expect(told).toEqual(["appearance"])
      expect(sent).toEqual([])
      // Another device forgot it: this one does too.
      other({ appearance: null })
      expect(theme.value()).toBeUndefined()
    })
  })

  context("without a runner that keeps them", () => {
    it("keeps each change on this device alone", () => {
      const theme = held("appearance", '"dusk"')
      theme.change('"noon"')
      expect(theme.value()).toBe('"noon"')
    })
  })
})
