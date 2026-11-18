import { createKept } from "@novadeck/viewers"
import { useEffect, useState } from "react"

import { blobs } from "../video/blobs"

// A recording's loudness along its length, which the waveform draws: fine peaks (0 to 1, a few
// thousand to a file) from the decoded bytes, cached by item and stamp, and reduced to as many
// bars as the waveform is wide.

// How many fine peaks a file gets, enough for a wide pane's bars to be reduced from.
export const fineCount = 2000

// Past these, a recording isn't decoded for its peaks: its whole decode would sit in memory.
export const limits = { bytes: 60 * 1024 * 1024, seconds: 30 * 60 } as const

// The fine peaks as `count` bars: each the loudest of its share. A share is never empty, so
// `count` above the fine peaks stretches them.
export const reduce = (fine: ArrayLike<number>, count: number): number[] => {
  const bars: number[] = []
  for (let bar = 0; bar < count; bar += 1) {
    const from = Math.min(fine.length - 1, Math.floor((bar * fine.length) / count))
    const to = Math.max(from + 1, Math.floor(((bar + 1) * fine.length) / count))
    let loudest = 0
    for (let at = from; at < to; at += 1) loudest = Math.max(loudest, fine[at] ?? 0)
    bars.push(loudest)
  }
  return bars
}

// A browser with Web Audio decodes; jsdom doesn't.
const decoding = (): boolean => typeof OfflineAudioContext === "function"

// Decodes `bytes` and takes the loudest sample of each of up to `fineCount` stretches of it,
// over every channel. The loudest of all is 1, and the square root lifts the quiet parts, so
// speech and music both show a shape. Undefined where the browser can't decode them.
export const decodePeaks = async (bytes: ArrayBuffer): Promise<Float32Array | undefined> => {
  if (!decoding()) return undefined
  try {
    // A low rate: the decode is resampled to it, and a peak needs no more, so a long file
    // takes a fraction of the memory.
    const buffer = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(bytes)
    const count = Math.min(fineCount, buffer.length)
    if (count === 0) return undefined
    const fine = new Float32Array(count)
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel)
      for (let at = 0; at < count; at += 1) {
        const from = Math.floor((at * samples.length) / count)
        const to = Math.max(from + 1, Math.floor(((at + 1) * samples.length) / count))
        let loudest = fine[at]!
        for (let sample = from; sample < to; sample += 1)
          loudest = Math.max(loudest, Math.abs(samples[sample]!))
        fine[at] = loudest
      }
    }
    const top = Math.max(...fine)
    return top === 0 ? undefined : fine.map((peak) => Math.sqrt(peak / top))
  } catch {
    return undefined
  }
}

// By item, the latest file's: `null` where it has none (too long, or it didn't decode), so
// it isn't tried again each time its pane comes back.
type Cached = { readonly stamp: string; readonly peaks: Float32Array | null }
const cache = createKept<Cached>(12)

// The peaks of the file at `url` (the item's, as `stamp` names it) once its length is known:
// undefined while they are being worked out, null where there are none and the waveform is
// flat. Playing never waits for them. A newer file's are awaited with the old one's drawn.
export const usePeaks = ({
  id,
  stamp,
  url,
  size,
  duration,
}: {
  id: string
  stamp: string
  url: string
  size: number
  duration: number
}): Float32Array | null | undefined => {
  const [got, setGot] = useState<Cached>()
  const cached = cache.get(id)
  const current = cached?.stamp === stamp ? cached : undefined
  // Too long to decode, or nothing here to decode with: flat, whatever the file holds.
  const flat = size > limits.bytes || duration > limits.seconds || !decoding()
  useEffect(() => {
    if (current || flat || duration === 0) return
    let stopped = false
    void (async () => {
      let peaks: Float32Array | undefined
      try {
        peaks = await decodePeaks((await blobs.bytes(url)?.arrayBuffer()) ?? new ArrayBuffer(0))
      } catch {
        peaks = undefined
      }
      if (stopped) return
      const result = { stamp, peaks: peaks ?? null }
      cache.keep(id, result)
      setGot(result)
    })()
    return () => {
      stopped = true
    }
  }, [id, stamp, url, flat, duration, current])
  if (flat && duration > 0) return null
  return (current ?? got)?.peaks
}
