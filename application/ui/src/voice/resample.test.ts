import { describe, expect, it } from "../test"
import { createChunker, createResampler, level, toInt16, voiceSampleRate } from "./resample"

const tone = (frequency: number, rate: number, seconds: number): Float32Array =>
  Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, index) => 0.5 * Math.sin((2 * Math.PI * frequency * index) / rate),
  )

// The tone's amplitude in the middle of the signal, away from the filter's edges.
const amplitude = (samples: Int16Array): number => {
  const middle = samples.slice(Math.floor(samples.length / 4), Math.floor((samples.length * 3) / 4))
  return Math.max(...middle.map(Math.abs)) / 32768
}

describe("toInt16", () => {
  it("scales full range to the 16-bit extremes", () => {
    expect([...toInt16([-1, 0, 1])]).toEqual([-32768, 0, 32767])
  })

  it("clamps samples that overshoot", () => {
    expect([...toInt16([-3, 2.5])]).toEqual([-32768, 32767])
  })

  it("rounds to the nearest step", () => {
    expect([...toInt16([0.5, -0.5])]).toEqual([16384, -16384])
  })
})

describe("createResampler", () => {
  it("passes samples through when the rate already matches", () => {
    const input = tone(440, voiceSampleRate, 0.1)
    expect(createResampler(voiceSampleRate).push(input)).toEqual(toInt16(input))
  })

  it("produces one 16 kHz sample for each three of 48 kHz", () => {
    const out = createResampler(48_000).push(tone(440, 48_000, 1))
    // The filter holds back a few samples at the end for the next call.
    expect(out.length).toBeGreaterThan(15_950)
    expect(out.length).toBeLessThanOrEqual(16_000)
  })

  it("keeps speech frequencies at their level", () => {
    for (const [rate, frequency] of [
      [48_000, 440],
      [48_000, 3_000],
      [44_100, 1_000],
    ] as const) {
      const out = createResampler(rate).push(tone(frequency, rate, 1))
      expect(amplitude(out)).toBeGreaterThan(0.48)
      expect(amplitude(out)).toBeLessThan(0.52)
    }
  })

  it("keeps the tone's frequency", () => {
    const out = createResampler(48_000).push(tone(1_000, 48_000, 1))
    // Rising zero crossings in a second of a 1 kHz tone.
    const crossings = out.reduce(
      (count, sample, index) => count + (index > 0 && out[index - 1]! < 0 && sample >= 0 ? 1 : 0),
      0,
    )
    expect(Math.abs(crossings - 1_000)).toBeLessThanOrEqual(2)
  })

  it("filters what 16 kHz can't hold instead of folding it into the speech", () => {
    // 10 kHz would alias to 6 kHz at full strength under plain decimation.
    const out = createResampler(48_000).push(tone(10_000, 48_000, 1))
    expect(amplitude(out)).toBeLessThan(0.01)
  })

  it("gives the same samples however the input is split", () => {
    const input = tone(700, 48_000, 0.5)
    const whole = createResampler(48_000).push(input)
    const pieces = createResampler(48_000)
    const parts = [0, 1, 1000, 1001, 5000, input.length].flatMap((start, index, all) =>
      index === 0 ? [] : [pieces.push(input.slice(all[index - 1], start))],
    )
    const joined = Int16Array.from(parts.flatMap((part) => [...part]))
    expect(joined).toEqual(whole)
  })

  it("lets an input slower than 16 kHz through without removing anything", () => {
    const out = createResampler(8_000).push(tone(500, 8_000, 1))
    expect(out.length).toBeGreaterThan(15_900)
    expect(amplitude(out)).toBeGreaterThan(0.48)
  })
})

describe("level", () => {
  it("is zero for silence and lifts speech to a visible fraction", () => {
    expect(level(new Float32Array(128))).toBe(0)
    expect(level(new Float32Array(0))).toBe(0)
    expect(level(tone(300, 48_000, 0.1))).toBeGreaterThan(0.5)
  })

  it("never passes 1", () => {
    expect(level(new Float32Array(64).fill(1))).toBe(1)
  })
})

describe("createChunker", () => {
  it("holds samples back until a chunk is full, then sends them together", () => {
    const chunks: number[][] = []
    const chunker = createChunker(4, (chunk) => chunks.push([...chunk]))
    chunker.add(Int16Array.of(1, 2))
    expect(chunks).toEqual([])
    chunker.add(Int16Array.of(3, 4, 5))
    expect(chunks).toEqual([[1, 2, 3, 4, 5]])
  })

  it("sends the remainder on flush, and nothing when empty", () => {
    const chunks: number[][] = []
    const chunker = createChunker(10, (chunk) => chunks.push([...chunk]))
    chunker.flush()
    chunker.add(Int16Array.of(7, 8))
    chunker.flush()
    chunker.flush()
    expect(chunks).toEqual([[7, 8]])
  })
})
