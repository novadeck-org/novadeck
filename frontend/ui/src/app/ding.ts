import type { Backend } from "@novadeck/core/port"
import { defaultNoticeSound, type NoticeSound } from "@novadeck/core/sounds"

import { soundInEffect, soundUrl } from "../sounds"
import type { UiStore } from "./ui-store"

// Novadeck's own sound for ringing the person, the same on every system: the host's
// notifications stay silent and this plays instead. The sound is the person's choice or,
// by default, the shown theme's; the sounds themselves are the files in sounds/.

// Bursts of rings sound once: a second ring within this of the last one is the same call.
export const dingGapMs = 1500

// A terminal that just rang doesn't ring again this soon: its finish notice and the question
// it asks a moment later (the question waits 2 s of grace first) are one call on the person,
// where a terminal that needs them again after a while is a new one. Long enough to cover
// that hop with room for a slow agent, short enough that real follow-ups still sound.
export const dingTerminalMs = 10_000

// The part of an audio element the ding drives, so a test can stand in for one.
export type DingAudio = { readonly play: () => Promise<void> | void }

export type Ding = {
  // Whether the person wants the sound, as a notice tells the host.
  readonly on: () => boolean
  // The sound in effect (the person's choice or the theme's), as a notice tells a host that
  // plays it.
  readonly sound: () => NoticeSound
  // Whether a ring for `key` (a terminal) may sound: the person wants the sound, nothing
  // rang just now and `key` didn't ring lately. Counts as a ring when it says yes, so a
  // host that plays the sound itself calls this alone and marks its notice by the answer.
  readonly take: (key: string) => boolean
  // Plays the ding unless the system is holding notifications. Never throws.
  readonly play: () => void
  // `take`, then `play`: for a ring the page sounds itself.
  readonly ring: (key: string) => void
  // Sounds it at `volume` whatever the settings and the system say, for the person to hear
  // what they are setting: the sound in effect, or `sound`, one just picked that the
  // settings may not hold yet.
  readonly preview: (volume: number, sound?: NoticeSound) => void
}

const element = (volume: number, sound: NoticeSound): DingAudio => {
  const audio = new Audio(soundUrl(sound))
  audio.volume = Math.min(1, Math.max(0, volume))
  return audio
}

export const createDing = ({
  sound,
  quiet,
  audio = element,
  // A clock that never steps back, as the wall clock may when it is set.
  now = () => performance.now(),
}: {
  // The person's setting and the sound in effect, read as the ding rings, so a change of
  // either, the theme included, holds at once.
  sound: () => { readonly on: boolean; readonly volume: number; readonly name: NoticeSound }
  // The host's check for the system's Do Not Disturb or Focus; true holds the ding back.
  quiet?: (() => Promise<boolean>) | undefined
  audio?: (volume: number, sound: NoticeSound) => DingAudio
  now?: () => number
}): Ding => {
  let last = -Infinity
  const lastOf = new Map<string, number>()
  const playAt = (volume: number, name: NoticeSound = sound().name): void => {
    try {
      void Promise.resolve(audio(volume, name).play()).catch(() => {})
    } catch {
      // No audio, or the page may not play yet: the notification still shows.
    }
  }
  const take = (key: string): boolean => {
    const at = now()
    if (
      !sound().on ||
      at - last < dingGapMs ||
      at - (lastOf.get(key) ?? -Infinity) < dingTerminalMs
    )
      return false
    last = at
    lastOf.set(key, at)
    for (const [each, when] of lastOf) if (at - when >= dingTerminalMs) lastOf.delete(each)
    return true
  }
  const play = (): void => {
    const { volume, name } = sound()
    void (async () => {
      try {
        if (await quiet?.()) return
      } catch {
        // A check that fails doesn't hold the sound back.
      }
      playAt(volume, name)
    })()
  }
  return {
    on: () => sound().on,
    sound: () => sound().name,
    take,
    play,
    ring: (key) => {
      if (take(key)) play()
    },
    preview: (volume, name) => playAt(volume, name),
  }
}

const mute: Ding = {
  on: () => false,
  sound: () => defaultNoticeSound,
  take: () => false,
  play: () => {},
  ring: () => {},
  preview: () => {},
}

const dings = new WeakMap<object, Ding>()

// The app's ding on a backend: one per backend, reading the person's settings from `ui`.
export const dingOf = (backend: Backend, ui: UiStore): Ding => {
  const known = dings.get(backend)
  if (known) return known
  // Sounds only where the host shows desktop notifications; the browser demo and the site's
  // live app stay silent.
  if (!backend.notices) {
    dings.set(backend, mute)
    return mute
  }
  const ding = createDing({
    sound: () => {
      const { preferences } = ui.getSnapshot()
      return {
        on: preferences.sound,
        volume: preferences.soundVolume,
        name: soundInEffect(preferences),
      }
    },
    quiet: async () => (await backend.notices?.quiet?.()) ?? false,
  })
  dings.set(backend, ding)
  return ding
}
