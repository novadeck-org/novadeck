// What the engine takes: 16 kHz mono 16-bit samples, which `VoiceClip.append` expects.
export const voiceSampleRate = 16_000

// How many zero crossings of the sinc each side of an output sample the filter spans.
// More crossings cut aliasing harder and cost more per sample; 8 is ample for speech.
const crossings = 8

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x))

// Blackman window over -1..1, which keeps the sinc's ripple small without a wide kernel.
const blackman = (x: number): number =>
  0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x)

export const toInt16 = (samples: readonly number[] | Float32Array): Int16Array => {
  const out = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!))
    // Asymmetric on purpose: -1 reaches -32768 and +1 reaches 32767.
    out[index] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
  }
  return out
}

export type Resampler = {
  // Takes the next run of samples at the input rate and returns the 16 kHz samples it
  // completes. Output lags the input by the filter's half-width, under a millisecond.
  readonly push: (samples: Float32Array) => Int16Array
}

// Converts a microphone's samples to 16 kHz with a windowed-sinc low-pass at the output's
// Nyquist rate, so frequencies the engine can't represent are filtered rather than folded
// back into the speech as plain decimation would. It streams: each call continues where
// the last stopped.
export const createResampler = (inputRate: number): Resampler => {
  const ratio = voiceSampleRate / inputRate
  // Taking every sample as is, when the rate already matches.
  if (ratio >= 1 && Math.abs(ratio - 1) < 1e-9) return { push: (samples) => toInt16(samples) }
  // Below the output's Nyquist the filter passes everything; an upsampled input has
  // nothing above its own to remove.
  const cutoff = Math.min(1, ratio)
  const half = crossings / cutoff
  // Samples kept from earlier calls, and where the next output sits among them.
  let history = new Float32Array(0)
  let position = 0
  return {
    push: (samples) => {
      const buffer = new Float32Array(history.length + samples.length)
      buffer.set(history)
      buffer.set(samples, history.length)
      const out: number[] = []
      // An output needs every input up to `position + half`.
      while (position + half < buffer.length) {
        const first = Math.max(0, Math.ceil(position - half))
        const last = Math.floor(position + half)
        let sum = 0
        for (let index = first; index <= last; index++) {
          const offset = index - position
          sum += buffer[index]! * cutoff * sinc(offset * cutoff) * blackman(offset / half)
        }
        out.push(sum)
        position += 1 / ratio
      }
      // Keep what a later output's window still reaches.
      const keep = Math.max(0, Math.min(buffer.length, Math.ceil(position - half)))
      history = buffer.slice(keep)
      position -= keep
      return toInt16(out)
    },
  }
}

// The loudness of a run of samples as 0 to 1, for a level meter: speech sits well below
// full scale, so the root mean square is lifted and clamped.
export const level = (samples: Float32Array): number => {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.min(1, Math.sqrt(sum / samples.length) * 4)
}

// Collects samples into runs of about `size`, so the backend gets a steady trickle of
// chunks instead of one per audio callback.
export const createChunker = (
  size: number,
  emit: (chunk: Int16Array) => void,
): { readonly add: (samples: Int16Array) => void; readonly flush: () => void } => {
  let pending: Int16Array[] = []
  let length = 0
  const flush = (): void => {
    if (length === 0) return
    const chunk = new Int16Array(length)
    let at = 0
    for (const part of pending) {
      chunk.set(part, at)
      at += part.length
    }
    pending = []
    length = 0
    emit(chunk)
  }
  return {
    add: (samples) => {
      if (samples.length === 0) return
      pending.push(samples)
      length += samples.length
      if (length >= size) flush()
    },
    flush,
  }
}
