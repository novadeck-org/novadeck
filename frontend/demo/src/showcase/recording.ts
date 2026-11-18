// The demo's one recording, so the pane's player has something to play and a waveform to draw:
// its format and size, which its item shows at once, and its bytes, which are loaded
// (`recording-data.ts`, 39 KB of text) only when something plays it.

export const recordingSize = 28842
export const recordingMime = "audio/ogg"

export const recording = async (): Promise<Uint8Array<ArrayBuffer>> =>
  (await import("./recording-data")).bytes()
