// Whether the browser can play a video's bytes: it reads their length off a detached element
// before a pane swaps them in. A file caught while it was written in place (empty, or a
// render's first bytes without its index) can't, so the video that played goes on playing.
export const playable = (blob: Blob): Promise<boolean> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement("video")
    video.preload = "metadata"
    video.muted = true
    const done = (ok: boolean): void => {
      video.removeAttribute("src")
      video.load()
      URL.revokeObjectURL(url)
      resolve(ok)
    }
    video.addEventListener("loadedmetadata", () => done(true), { once: true })
    video.addEventListener("error", () => done(false), { once: true })
    video.src = url
  })
