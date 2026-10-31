import type { SQLTagStore } from "node:sqlite"

import {
  murmurCheck,
  runnerSettings,
  voiceCheck,
  voiceLanguage,
  voiceModel,
  type MurmurCheck,
  type MurmurSettings,
  type RunnerSettings,
  type VoiceCheck,
  type VoiceSettings,
} from "@novadeck/protocol"

/** Settings to change; those left out, or undefined, stay as they are. */
export type VoiceSettingsChange = {
  readonly [K in Exclude<keyof VoiceSettings, "enabled">]?: VoiceSettings[K] | undefined
} & {
  /** `null` forgets the choice, as when it is turned on before an install. */
  readonly enabled?: boolean | null | undefined
}

/** Why an install found this computer can't run murmur, and the engine build it ran. */
export type MurmurVerdict = { readonly reason: string; readonly engine: string }

/** Murmur's settings to change; `enabled: null` forgets the choice, as when it is turned on before an install. */
export type MurmurSettingsChange = {
  readonly enabled?: boolean | null | undefined
}

export type RunnerSettingsChange = {
  readonly [K in keyof RunnerSettings]?: RunnerSettings[K] | undefined
}

// Inbox rows as saved, by id, or none where they can't be read.
const inboxRowsOf = (text: string | undefined): string[] => {
  if (text === undefined) return []
  try {
    const order = runnerSettings.shape.inboxOrder.safeParse(JSON.parse(text))
    return order.success ? order.data : []
  } catch {
    return []
  }
}

/** What the person chose, kept in the store's settings table: the runner's, voice input's and murmur's. */
export class Settings {
  constructor(private readonly queries: SQLTagStore) {}

  /** The saved value of a setting; `undefined` when none is. */
  private setting(key: string): string | undefined {
    const row = this.queries.get`SELECT value FROM settings WHERE key = ${key}` as
      | { value: string }
      | undefined
    return row?.value
  }

  private saveSetting(key: string, value: string): void {
    void this.queries.run`
      INSERT INTO settings (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `
  }

  private forgetSetting(key: string): void {
    void this.queries.run`DELETE FROM settings WHERE key = ${key}`
  }

  /** Saves a setting as JSON; `null` forgets it. */
  private saveSettingJson(key: string, value: unknown): void {
    if (value === null) this.forgetSetting(key)
    else this.saveSetting(key, JSON.stringify(value))
  }

  /** Saves what is given under `prefix.`; `null` forgets a setting. */
  private saveGroup(prefix: string, settings: object): void {
    for (const [key, value] of Object.entries(settings)) {
      if (value === null) this.forgetSetting(`${prefix}.${key}`)
      else if (value !== undefined) this.saveSetting(`${prefix}.${key}`, String(value))
    }
  }

  /** A setting saved as JSON, as `read` takes it; `null` when there is none or it can't be read. */
  private settingJson<T>(key: string, read: (saved: unknown) => T | null): T | null {
    const text = this.setting(key)
    if (text === undefined) return null
    try {
      return read(JSON.parse(text))
    } catch {
      return null
    }
  }

  messagingPaused(): boolean {
    return this.setting("messagingPaused") === "true"
  }

  pauseMessaging(paused: boolean): void {
    this.saveSetting("messagingPaused", String(paused))
  }

  runner(): RunnerSettings {
    const rows = this.queries.all`SELECT key, value FROM settings` as {
      key: string
      value: string
    }[]
    const saved = new Map(rows.map((row) => [row.key, row.value]))
    // Transcripts are kept unless turned off; the welcome dialog waits until seen; the Inbox
    // keeps its own order until the person drags its rows, and snoozes none until they do.
    return {
      transcripts: saved.get("transcripts") !== "false",
      welcomed: saved.get("welcomed") === "true",
      inboxOrder: inboxRowsOf(saved.get("inboxOrder")),
      inboxSnoozed: inboxRowsOf(saved.get("inboxSnoozed")),
    }
  }

  // Each as JSON, which writes a switch as `true` or `false`, as it always was.
  saveRunner(settings: RunnerSettingsChange): void {
    for (const [key, value] of Object.entries(settings))
      if (value !== undefined) this.saveSetting(key, JSON.stringify(value))
  }

  /** Voice input's settings: off, on the lighter model, and detecting the language, until chosen. */
  voiceSettings(): VoiceSettings {
    const rows = this.queries.all`SELECT key, value FROM settings WHERE key LIKE 'voice.%'` as {
      key: string
      value: string
    }[]
    const saved = new Map(rows.map((row) => [row.key, row.value]))
    return {
      enabled: saved.get("voice.enabled") === "true",
      model: voiceModel.catch("turbo").parse(saved.get("voice.model")),
      language: voiceLanguage.catch("auto").parse(saved.get("voice.language")),
    }
  }

  /**
   * Whether the person chose voice input on or off: `undefined` until they, or an install,
   * did. A first install forgets an earlier off and turns it on; an off chosen during it,
   * or before a later model's install, survives.
   */
  voiceEnabledChoice(): boolean | undefined {
    const enabled = this.setting("voice.enabled")
    return enabled === undefined ? undefined : enabled === "true"
  }

  /** The check the last install passed, as saved; `null` when there is none or it can't be read. */
  voiceCheck(): VoiceCheck | null {
    return this.settingJson("voice.check", (saved) => {
      // Read leniently: a check an earlier build saved carries more than the wire has now.
      const parsed = voiceCheck.safeParse(
        typeof saved === "object" && saved !== null
          ? {
              model: (saved as Record<string, unknown>).model,
              milliseconds: (saved as Record<string, unknown>).milliseconds,
            }
          : saved,
      )
      return parsed.success ? parsed.data : null
    })
  }

  /** Replaces the saved check; `null` forgets it, as when voice input is removed. */
  saveVoiceCheck(check: VoiceCheck | null): void {
    this.saveSettingJson("voice.check", check)
  }

  /** Saves what is given; `enabled: null` forgets the choice. */
  saveVoiceSettings(settings: VoiceSettingsChange): void {
    this.saveGroup("voice", settings)
  }

  /** Murmur's settings: off until the person turns it on. */
  murmurSettings(): MurmurSettings {
    return { enabled: this.murmurEnabledChoice() === true }
  }

  /** Whether the person chose murmur on or off: `undefined` until they, or an install, did. */
  murmurEnabledChoice(): boolean | undefined {
    const enabled = this.setting("murmur.enabled")
    return enabled === undefined ? undefined : enabled === "true"
  }

  /** The check the last install passed, as saved; `null` when there is none or it can't be read. */
  murmurCheck(): MurmurCheck | null {
    return this.settingJson("murmur.check", (saved) => {
      const parsed = murmurCheck.safeParse(saved)
      return parsed.success ? parsed.data : null
    })
  }

  /** Replaces the saved check; `null` forgets it, as when murmur is removed. */
  saveMurmurCheck(check: MurmurCheck | null): void {
    this.saveSettingJson("murmur.check", check)
  }

  /**
   * Why an install found this computer can't run murmur, with the sha of the engine build
   * it ran; `null` when it never did or the value can't be read.
   */
  murmurUnsupported(): MurmurVerdict | null {
    return this.settingJson("murmur.unsupported", (saved) => {
      const { reason, engine } = saved as Partial<MurmurVerdict>
      return typeof reason === "string" && typeof engine === "string" ? { reason, engine } : null
    })
  }

  /** Remembers that this computer can't run murmur; `null` forgets it. */
  saveMurmurUnsupported(verdict: MurmurVerdict | null): void {
    this.saveSettingJson("murmur.unsupported", verdict)
  }

  /** In how many sessions of the app the one-time offer was shown. */
  murmurOffers(): number {
    const offers = Number(this.setting("murmur.offers"))
    return Number.isInteger(offers) && offers > 0 ? offers : 0
  }

  saveMurmurOffers(offers: number): void {
    this.saveSetting("murmur.offers", String(offers))
  }

  /** Saves what is given; `enabled: null` forgets the choice. */
  saveMurmurSettings(settings: MurmurSettingsChange): void {
    this.saveGroup("murmur", settings)
  }
}
