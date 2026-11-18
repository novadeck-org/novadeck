// The demo's one video, so the pane's player has something to play, step through frame by frame
// and mute: its format and size, which its item shows at once, and its bytes, which are loaded
// (`clip-data.ts`, 107 KB of text) only when something plays it.

export const clipSize = 80417
export const clipMime = "video/webm"

export const clip = async (): Promise<Uint8Array<ArrayBuffer>> =>
  (await import("./clip-data")).bytes()
