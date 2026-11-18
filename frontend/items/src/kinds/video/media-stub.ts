import { afterEach, beforeEach, vi } from "vitest"

// jsdom plays nothing: a media element here keeps what the player reads and sets, and
// `load` is what the browser does once the new source has its length.
type Media = { paused: boolean; time: number; duration: number }
const media = new WeakMap<HTMLMediaElement, Media>()
export const stateOf = (element: HTMLMediaElement): Media => {
  let state = media.get(element)
  if (!state) media.set(element, (state = { paused: true, time: 0, duration: NaN }))
  return state
}
const descriptors = Object.getOwnPropertyDescriptors(HTMLMediaElement.prototype)
const restore = ["paused", "currentTime", "duration", "play", "pause", "src"] as const
// Registers, for the test file that calls it, a media element that plays nothing and an object
// URL of its own, named by `prefix`.
export const stubMedia = (prefix: string): void => {
  beforeEach(() => {
    Object.defineProperties(HTMLMediaElement.prototype, {
      paused: {
        configurable: true,
        get: function (this: HTMLMediaElement) {
          return stateOf(this).paused
        },
      },
      currentTime: {
        configurable: true,
        get: function (this: HTMLMediaElement) {
          return stateOf(this).time
        },
        set: function (this: HTMLMediaElement, time: number) {
          stateOf(this).time = time
          this.dispatchEvent(new Event("seeked"))
        },
      },
      duration: {
        configurable: true,
        get: function (this: HTMLMediaElement) {
          return stateOf(this).duration
        },
      },
      play: {
        configurable: true,
        value: function (this: HTMLMediaElement) {
          stateOf(this).paused = false
          this.dispatchEvent(new Event("play"))
          return Promise.resolve()
        },
      },
      pause: {
        configurable: true,
        value: function (this: HTMLMediaElement) {
          stateOf(this).paused = true
          this.dispatchEvent(new Event("pause"))
        },
      },
      // A new source empties the element, as the browser does.
      src: {
        configurable: true,
        get: function (this: HTMLMediaElement) {
          return this.getAttribute("src") ?? ""
        },
        set: function (this: HTMLMediaElement, value: string) {
          this.setAttribute("src", value)
          Object.assign(stateOf(this), { paused: true, time: 0, duration: NaN })
        },
      },
    })
    let made = 0
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: () => `blob:${prefix}-${++made}`,
        revokeObjectURL: () => {},
      }),
    )
  })
  afterEach(() => {
    for (const name of restore) {
      const original = descriptors[name]
      if (original) Object.defineProperty(HTMLMediaElement.prototype, name, original)
      else delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>)[name]
    }
  })
}
