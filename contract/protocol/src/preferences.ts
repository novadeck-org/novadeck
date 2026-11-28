import { z } from "zod"

// The person's own preferences, which follow them from device to device: the runner keeps
// each by its key as the UI wrote it, without reading it, and tells every client of each
// change (dev-docs/backend-api.md, "Preferences"). What a preference means, and its default, is
// the UI's: it reads each value tolerantly, so an older or newer UI's never trips it.

// How many keys the runner keeps, and how long a value (JSON text) may be.
export const maxPreferences = 64
export const maxPreferenceLength = 16_384

/** A preference's name, as "appearance" or "sidebar-order". */
export const preferenceKey = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/)

/** A preference's value as the UI wrote it: JSON text, which the runner doesn't read. */
export const preferenceValue = z.string().min(1).max(maxPreferenceLength)

/**
 * The preferences as they are, or as they changed: `values` by key, a key whose preference
 * was forgotten as null; `revision`, which every change raises; and `writer`, the client
 * whose change it was, where one client's alone (`preferences.set`).
 */
export const preferenceChange = z.strictObject({
  values: z.record(preferenceKey, preferenceValue.nullable()),
  revision: z.number().int().nonnegative(),
  writer: z.string().min(1).max(64).nullable(),
})

export type PreferenceChange = z.infer<typeof preferenceChange>
