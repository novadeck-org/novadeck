import { createChunker, createResampler, level, voiceSampleRate } from "./resample"

export type Capture = {
  // Ends the recording for good: lets the last words land, then releases the microphone
  // and closes the audio graph, which turns the operating system's recording indicator
  // off. Resolves once the last samples have been handed over.
  readonly drain: () => Promise<void>
  // Releases the microphone and closes the graph at once, handing over nothing more. A
  // drain still waiting resolves.
  readonly stop: () => void
}

export type CaptureHandlers = {
  // 16 kHz mono 16-bit samples, a tenth of a second or so at a time.
  readonly onSamples: (samples: Int16Array) => void
  // Loudness from 0 to 1, as each block arrives.
  readonly onLevel: (level: number) => void
}

// What `startCapture` rejects with: a message for the person.
export class CaptureError extends Error {}

const chunkSamples = voiceSampleRate / 10

// Speech trails off after the key is let go, and what the microphone heard in the last
// tens of milliseconds is still on its way through the audio thread; capturing this much
// longer puts the last syllable in the clip.
export const tailMilliseconds = 150
// The longest wait for the audio thread to hand over its partial block.
export const flushMilliseconds = 300

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

type Tap = {
  readonly node: AudioNode
  // Resolves once every block the tap holds has reached `receive`.
  readonly flush: () => Promise<void>
}

const describe = (failure: unknown): string => {
  const name = failure instanceof DOMException ? failure.name : ""
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access is blocked. Allow it for novadeck in your system's privacy settings."
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found."
  if (name === "NotReadableError" || name === "AbortError")
    return "The microphone is busy or unavailable."
  return "Couldn't start the microphone."
}

// Where the worklet's module is served, beside the page: the UI is loaded from its own
// origin in the browser and from a file in the packaged app, and a path relative to the
// page works in both (the build's base is "./").
const workletUrl = (): string => new URL("voice-capture.worklet.js", document.baseURI).href

// Feeds blocks of the microphone's samples to `receive` on the main thread. An audio
// worklet does it off the main thread; where the module can't load, a script processor,
// deprecated but everywhere, does the same job on it.
const tap = async (
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  receive: (block: Float32Array) => void,
): Promise<Tap> => {
  try {
    await context.audioWorklet.addModule(workletUrl())
    const node = new AudioWorkletNode(context, "novadeck-voice-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    // Messages on a port arrive in order, so the worklet's "flushed" marker comes after
    // every block it posted before.
    const flushes: (() => void)[] = []
    node.port.addEventListener("message", (event: MessageEvent<Float32Array | "flushed">) => {
      if (event.data === "flushed") flushes.shift()?.()
      else receive(event.data)
    })
    node.port.start()
    source.connect(node)
    return {
      node,
      flush: () =>
        new Promise((resolve) => {
          flushes.push(resolve)
          // A message port has no origin to name, unlike a window.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          node.port.postMessage("flush")
        }),
    }
  } catch {
    const node = context.createScriptProcessor(4096, 1, 1)
    node.addEventListener("audioprocess", (event) =>
      receive(event.inputBuffer.getChannelData(0).slice()),
    )
    source.connect(node)
    // A script processor can't be asked for its partial buffer; the tail of capturing
    // after the stop is longer than the buffer it fills, so nothing is left in it.
    return { node, flush: () => Promise.resolve() }
  }
}

export const startCapture = async ({ onSamples, onLevel }: CaptureHandlers): Promise<Capture> => {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new CaptureError("This build can't record audio.")
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  } catch (failure) {
    throw new CaptureError(describe(failure))
  }
  const release = (): void => stream.getTracks().forEach((track) => track.stop())
  let context: AudioContext | undefined
  try {
    context = new AudioContext({ latencyHint: "interactive" })
    const resampler = createResampler(context.sampleRate)
    const chunker = createChunker(chunkSamples, onSamples)
    let open = true
    const source = context.createMediaStreamSource(stream)
    const { node, flush } = await tap(context, source, (block) => {
      if (!open) return
      onLevel(level(block))
      chunker.add(resampler.push(block))
    })
    // The graph is pulled only through the destination; the tap writes silence to it.
    const mute = context.createGain()
    mute.gain.value = 0
    node.connect(mute).connect(context.destination)
    // A context may start suspended until the page has been interacted with.
    if (context.state === "suspended") await context.resume()
    const running = context
    const close = (): void => {
      open = false
      node.disconnect()
      source.disconnect()
      release()
      void running.close()
    }
    let draining: Promise<void> | undefined
    return {
      drain: () => {
        draining ??= (async () => {
          await sleep(tailMilliseconds)
          if (!open) return
          await Promise.race([flush(), sleep(flushMilliseconds)])
          // Stopped for good while waiting: nothing more is wanted.
          if (!open) return
          chunker.flush()
          close()
        })()
        return draining
      },
      stop: () => {
        if (open) close()
      },
    }
  } catch (failure) {
    release()
    void context?.close()
    throw new CaptureError(failure instanceof CaptureError ? failure.message : describe(failure))
  }
}
