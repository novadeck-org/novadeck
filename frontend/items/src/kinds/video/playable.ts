// Whether the browser can play a video's or a recording's bytes: it reads their length off a
// detached element of that `kind` before a pane swaps them in. A file caught while it was
// written in place (empty, or a render's first bytes without its index) can't, so what played
// goes on playing.
export const playable = (blob: Blob, kind: "video" | "audio" = "video"): Promise<boolean> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const element = document.createElement(kind)
    element.preload = "metadata"
    element.muted = true
    const done = (ok: boolean): void => {
      element.removeAttribute("src")
      element.load()
      URL.revokeObjectURL(url)
      resolve(ok)
    }
    element.addEventListener("loadedmetadata", () => done(true), { once: true })
    element.addEventListener("error", () => done(false), { once: true })
    element.src = url
  })
