// The bracket a CAD step wrote into the render folder: its bytes, made when a pane or a folder's
// grid reads them, so they stay out of the demo's load, and its size, which its listing gives
// before they're read (the showcase's tests check it against them).
export const bracketBytes = async (): Promise<Uint8Array<ArrayBuffer>> =>
  (await import("./model")).bracket(60)
export const bracketSize = 2484
