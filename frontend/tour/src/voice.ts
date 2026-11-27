import { narration } from "./steps"

// Nyx's voice-over: each line the caption box letters, said as its box shows, in her own voice
// from the owner's skits. The takes are `voice/<key>.mp3`, one per line of `narration()`, made as
// NARRATION.md says. A line without a take is lettered and not said.

// Always files, fetched as a line is first said: never inlined, as the page's content policy
// refuses a data: URL, and none of them weighs on the app's first load.
const files = import.meta.glob<string>("./voice/*.mp3", {
  query: "?no-inline",
  import: "default",
  eager: true,
})

// A line's take, by its words.
let takes: ReadonlyMap<string, string> | null = null
export const takeOf = (line: string): string | undefined => {
  takes ??= new Map(
    [...narration()].flatMap(([key, said]) => {
      const url = files[`./voice/${key}.mp3`]
      return url === undefined ? [] : [[said, url] as const]
    }),
  )
  return takes.get(line)
}

// Whether the person turned her voice off, kept for every tour after, in this browser.
export const mutedKey = "novadeck.tour.voice-off"

// How loud she is: a little under full, beside whatever the agents' pages play.
const volume = 0.85

// The part of an audio element the voice drives, so a test can stand in for one.
export type VoiceAudio = {
  volume: number
  readonly play: () => Promise<void> | void
  readonly pause: () => void
}

export type Voice = {
  // Whether she speaks: not while the person has turned her off.
  readonly on: () => boolean
  readonly set: (on: boolean) => void
  readonly subscribe: (listener: () => void) => () => void
  // Says a line as its box shows: the line said before stops where it is, as the box it was for
  // has gone. A line said again at once (its box drawn again) isn't said twice.
  readonly say: (line: string) => void
  // Stops her, as the tour goes out of sight or ends.
  readonly stop: () => void
}

export const createVoice = ({
  take = takeOf,
  audio = (url) => new Audio(url),
  store = () => localStorage,
}: {
  take?: (line: string) => string | undefined
  audio?: (url: string) => VoiceAudio
  store?: () => Pick<Storage, "getItem" | "setItem" | "removeItem">
} = {}): Voice => {
  let playing: VoiceAudio | null = null
  let last: string | null = null
  const listeners = new Set<() => void>()
  const on = (): boolean => {
    try {
      return store().getItem(mutedKey) === null
    } catch {
      return true
    }
  }
  const stop = (): void => {
    playing?.pause()
    playing = null
    last = null
  }
  return {
    on,
    set: (value) => {
      try {
        if (value) store().removeItem(mutedKey)
        else store().setItem(mutedKey, "1")
      } catch {
        // Not kept: it holds for this page all the same.
      }
      if (!value) stop()
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      // Turned off or on in another window of the app, which shares the storage.
      const stored = (event: StorageEvent): void => {
        if (event.key !== mutedKey && event.key !== null) return
        if (!on()) stop()
        listener()
      }
      if (typeof window !== "undefined") window.addEventListener("storage", stored)
      return () => {
        listeners.delete(listener)
        if (typeof window !== "undefined") window.removeEventListener("storage", stored)
      }
    },
    say: (line) => {
      if (line === last) return
      stop()
      last = line
      const url = take(line)
      if (!on() || url === undefined) return
      const now = audio(url)
      now.volume = volume
      playing = now
      // Played at once, never a tick later: a take stopped in the same tick (StrictMode's second
      // effect, a newer line) would start all the same, and no longer be the one stop reaches. A
      // page that may not play sound yet (no click on it so far) keeps the caption alone.
      try {
        void Promise.resolve(now.play()).catch(() => {})
      } catch {
        // As refused.
      }
    },
    stop,
  }
}

// The tour's one voice, shared by its stage and its closing card.
export const tourVoice: Voice = createVoice()
