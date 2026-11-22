import { registerPerson, savePerson } from "@novadeck/core/person"
import type { Store } from "@novadeck/core/store"
import type { PreferencesValue } from "@novadeck/core/types"

import { personPreferences, preferencesFrom } from "../preferences/preferences-storage"
import type { UiState, UiStore } from "./ui-store"

type PersonField = keyof typeof personPreferences

const fields = Object.keys(personPreferences) as PersonField[]

// The UI store's settings that follow the person (core's person.ts): the preferences
// `personPreferences` names, and whether the Agent Chat offer was answered. Each reads as the
// store holds it, takes another device's through `update`, as preferences another window saved
// are taken, and goes to the runner as this device changes it. Returns the stop.
export const followPersonPreferences = (
  ui: UiStore,
  update: (next: PreferencesValue) => void,
): (() => void) => {
  const preferences = (): PreferencesValue => ui.getSnapshot().preferences
  const stops = fields.map((field) =>
    registerPerson({
      key: personPreferences[field],
      read: () => JSON.stringify(preferences()[field]),
      write: (text) => {
        let value: unknown
        try {
          value = text === null ? undefined : JSON.parse(text)
        } catch {
          return
        }
        // Read as a saved preference is: what this build can't read is its default.
        const next = preferencesFrom({ ...preferences(), [field]: value })
        if (JSON.stringify(next[field]) !== JSON.stringify(preferences()[field]))
          update({ ...preferences(), [field]: next[field] })
      },
    }),
  )
  // Answered once anywhere is answered: only an answer is ever kept or taken.
  stops.push(
    registerPerson({
      key: chatOfferKey,
      read: () => (ui.getSnapshot().chatOfferAnswered ? "true" : undefined),
      write: (text) => {
        if (text === "true")
          ui.update((state) =>
            state.chatOfferAnswered ? state : { ...state, chatOfferAnswered: true },
          )
      },
    }),
  )
  stops.push(saveChanges(ui))
  return () => stops.forEach((stop) => stop())
}

export const chatOfferKey = "agent-chat-offer-answered"

// Sends each setting this device changed, as the store changes.
const saveChanges = (ui: Store<UiState>): (() => void) => {
  let last = ui.getSnapshot()
  return ui.subscribe(() => {
    const next = ui.getSnapshot()
    if (next === last) return
    const before = last
    last = next
    if (next.preferences !== before.preferences)
      for (const field of fields)
        if (JSON.stringify(next.preferences[field]) !== JSON.stringify(before.preferences[field]))
          savePerson(personPreferences[field])
    if (next.chatOfferAnswered !== before.chatOfferAnswered) savePerson(chatOfferKey)
  })
}
