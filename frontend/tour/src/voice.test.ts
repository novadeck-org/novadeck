import { narration } from "./steps"
import { describe, expect, it } from "./test"
import { createVoice, mutedKey, takeOf, type VoiceAudio } from "./voice"

// A stand-in for the page's storage and audio elements: what was played, and what stopped.
const rig = (take: (line: string) => string | undefined = (line) => `/voice/${line}.mp3`) => {
  const kept = new Map<string, string>()
  const store = () => ({
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  })
  const played: { url: string; paused: boolean; volume: number }[] = []
  const audio = (url: string): VoiceAudio => {
    const each = { url, paused: false, volume: 1 }
    played.push(each)
    return {
      set volume(value: number) {
        each.volume = value
      },
      get volume() {
        return each.volume
      },
      play: () => Promise.resolve(),
      pause: () => {
        each.paused = true
      },
    }
  }
  return { voice: createVoice({ take, audio, store }), played, kept }
}

describe("Nyx's voice-over", () => {
  it("says each line as its box shows, cutting off the one before", () => {
    const { voice, played } = rig()
    voice.say("Your game's running. Go look.")
    voice.say("There. Nothing in it yet. Give it time.")
    expect(played.map(({ url, paused }) => [url, paused])).toEqual([
      ["/voice/Your game's running. Go look..mp3", true],
      ["/voice/There. Nothing in it yet. Give it time..mp3", false],
    ])
    expect(played[1]!.volume).toBeLessThan(1)
  })

  it("doesn't say a line twice when its box is drawn again", () => {
    const { voice, played } = rig()
    voice.say("They're finishing it. Relax.")
    voice.say("They're finishing it. Relax.")
    expect(played).toHaveLength(1)
  })

  it("says a line again once the tour came back to it", () => {
    const { voice, played } = rig()
    voice.say("They're finishing it. Relax.")
    voice.stop()
    voice.say("They're finishing it. Relax.")
    expect(played.map(({ paused }) => paused)).toEqual([true, false])
  })

  it("keeps quiet while turned off, stops at once, and keeps the choice", () => {
    const { voice, played, kept } = rig()
    voice.say("That's your agent. It does the work. I talk.")
    voice.set(false)
    expect(played[0]!.paused).toBe(true)
    expect(kept.get(mutedKey)).toBe("1")
    voice.say("Your call. What game? Make it a good one.")
    expect(played).toHaveLength(1)
    voice.set(true)
    expect(voice.on()).toBe(true)
    voice.say("It wants to run the game. Fine. Say yes.")
    expect(played).toHaveLength(2)
  })

  it("tells who listens when it's turned on or off", () => {
    const { voice } = rig()
    let told = 0
    const stop = voice.subscribe(() => (told += 1))
    voice.set(false)
    stop()
    voice.set(true)
    expect(told).toBe(1)
  })

  it("letters a line with no take and says nothing", () => {
    const { voice, played } = rig(() => undefined)
    voice.say("A line not recorded yet.")
    expect(played).toEqual([])
  })

  it("never throws where the page may not play sound yet", async () => {
    const voice = createVoice({
      take: () => "/x.mp3",
      audio: () => ({
        volume: 1,
        play: () => Promise.reject(new Error("NotAllowedError")),
        pause: () => {},
      }),
      store: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
    })
    expect(() => voice.say("Line.")).not.toThrow()
    await Promise.resolve()
  })

  it("has a take for every line the tour says, so a changed line gets a new one", () => {
    const unsaid = [...narration()].filter(([, line]) => takeOf(line) === undefined)
    expect(unsaid.map(([key]) => key)).toEqual([])
  })

  it("finds no take for words the tour never says", () => {
    expect(takeOf("Not a line of the tour.")).toBeUndefined()
  })
})
