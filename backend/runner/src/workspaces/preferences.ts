import type { PreferenceChange } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { PreferenceFeed } from "./settings-feed.js"
import type { Settings } from "./settings.js"

/**
 * The person's preferences (`preferences.*`): kept in the runner's settings as the UI wrote
 * them, and told to every client as they change.
 */
export class Preferences {
  private readonly feed: PreferenceFeed

  constructor(private readonly settings: Pick<Settings, "preferences" | "savePreference">) {
    this.feed = new PreferenceFeed(() => this.get())
  }

  /** Every preference kept, and their revision. */
  get(): PreferenceChange {
    return { ...this.settings.preferences(), writer: null }
  }

  /**
   * Keeps `value` as `key`, or forgets it for null, as `writer` changed it, and tells every
   * client; resolves the new revision. A new key past `maxPreferences` is a CONFLICT.
   */
  set(input: { readonly key: string; readonly value: string | null; readonly writer: string }): {
    readonly revision: number
  } {
    const revision = this.settings.savePreference(input.key, input.value)
    if (revision === undefined)
      throw new DomainError("CONFLICT", "The runner keeps no more preferences.")
    this.feed.changed(input.key, input.value, revision, input.writer)
    return { revision }
  }

  /** One client's stream: every preference, then each change, until `signal` aborts. */
  watch(signal: AbortSignal): AsyncGenerator<PreferenceChange> {
    return this.feed.watch(signal)
  }
}

/** The person's preferences kept in `settings`. */
export const keptPreferences = (
  settings: Pick<Settings, "preferences" | "savePreference">,
): Preferences => new Preferences(settings)
