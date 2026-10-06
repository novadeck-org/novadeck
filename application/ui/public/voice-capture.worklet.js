/* eslint-disable unicorn/require-post-message-target-origin -- Every postMessage here is the worklet's MessagePort, which takes no origin. */
// Runs on the audio thread: hands the microphone's samples to the page in blocks of
// about 43 ms at 48 kHz. The page resamples them to 16 kHz (src/voice/resample.ts), so
// the filter exists once, in code with tests. Served as is, from the UI's own origin,
// because the page's content security policy allows scripts from nowhere else.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(2048)
    this.filled = 0
    // The page asks for what is held when it stops listening: the partial block goes out,
    // then a marker, so the page knows nothing else is in flight.
    this.port.addEventListener("message", (event) => {
      if (event.data !== "flush") return
      if (this.filled > 0) {
        this.port.postMessage(this.block.slice(0, this.filled))
        this.filled = 0
      }
      this.port.postMessage("flushed")
    })
    // A port delivers to listeners added this way only once started.
    this.port.start()
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let offset = 0
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.block.length - this.filled)
      this.block.set(channel.subarray(offset, offset + count), this.filled)
      this.filled += count
      offset += count
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block, [this.block.buffer])
        this.block = new Float32Array(2048)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor("novadeck-voice-capture", VoiceCapture)
