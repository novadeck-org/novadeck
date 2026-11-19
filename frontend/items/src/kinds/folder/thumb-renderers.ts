import { loadParts } from "../../parts/load"
import { registerEntryThumb, type EntryThumbRenderer } from "./entry-thumbs"
import { videoFrameBytes } from "./model"

// The kinds the folder draws itself, registered as any other kind would: an image is itself, up
// to what one part holds; a video is its first moment and its length.

// What the runner shows as an image (`images` in its companions/content.ts), by extension.
const imageMimes: Record<string, string | undefined> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  pjpeg: "image/jpeg",
  pjp: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  jxl: "image/jxl",
  bmp: "image/bmp",
  ico: "image/x-icon",
  cur: "image/x-icon",
  svg: "image/svg+xml",
}

const videoMimes: Record<string, string | undefined> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
}

const extensionOf = (name: string): string => name.slice(name.lastIndexOf(".") + 1).toLowerCase()

// The most of an image read for its picture, which is one part.
const imageBytes = 2 * 1024 * 1024

// A file read whole, as a blob of its format; null where it can't be (stopped, changed, refused).
const wholeFile = async (
  file: Parameters<EntryThumbRenderer>[0],
  mime: string,
  signal: AbortSignal,
): Promise<Blob | null> => {
  const loaded = await loadParts({
    read: (offset) => file.read(offset, signal),
    size: file.size,
    mime,
    signal,
    progress: () => {},
  })
  return loaded.state === "ready" ? loaded.blob : null
}

// The widest a video's frame is drawn.
const frameWidth = 320

// A video's first moment, drawn small, and its length; undefined where the page can't play it.
const frameOf = (
  video: Blob,
  signal: AbortSignal,
): Promise<{ readonly picture: Blob; readonly duration: number } | undefined> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(video)
    const element = document.createElement("video")
    element.muted = true
    element.preload = "auto"
    const done = (
      result: { readonly picture: Blob; readonly duration: number } | undefined,
    ): void => {
      clearTimeout(timer)
      signal.removeEventListener("abort", stop)
      element.removeAttribute("src")
      element.load()
      URL.revokeObjectURL(url)
      resolve(result)
    }
    // Whoever asked stopped waiting: the queue's place is free at once, not after the timeout.
    const stop = (): void => done(undefined)
    const timer = setTimeout(stop, 10_000)
    signal.addEventListener("abort", stop, { once: true })
    if (signal.aborted) return stop()
    element.addEventListener("error", () => done(undefined))
    element.addEventListener("loadedmetadata", () => {
      // A moment in, past a fade from black, where the video is long enough.
      element.currentTime = Math.min(1, (element.duration || 0) / 10)
    })
    element.addEventListener("seeked", () => {
      const { videoWidth: width, videoHeight: height } = element
      if (!width || !height) return done(undefined)
      const canvas = document.createElement("canvas")
      canvas.width = Math.min(frameWidth, width)
      canvas.height = Math.round((canvas.width * height) / width)
      canvas.getContext("2d")?.drawImage(element, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(
        (picture) =>
          done(
            picture && Number.isFinite(element.duration)
              ? { picture, duration: element.duration }
              : undefined,
          ),
        "image/jpeg",
        0.72,
      )
    })
    element.src = url
  })

// Whether the page can draw an image: one being written, cut short or misnamed can't.
const decodes = async (blob: Blob): Promise<boolean> => {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return true
  } catch {
    return false
  } finally {
    URL.revokeObjectURL(url)
  }
}

registerEntryThumb("image", async (file, _box, signal) => {
  // An empty file is one an agent has only begun: its stamp changes as it is written.
  if (file.size === 0 || file.size > imageBytes) return null
  const blob = await wholeFile(
    file,
    imageMimes[extensionOf(file.name)] ?? "application/octet-stream",
    signal,
  )
  return blob && (await decodes(blob)) ? { blob } : null
})

// A video is read whole to learn its first frame and length (its index may be at the end), so a
// larger one shows its icon.
registerEntryThumb("video", async (file, _box, signal) => {
  if (file.size > videoFrameBytes) return null
  const blob = await wholeFile(file, videoMimes[extensionOf(file.name)] ?? "video/mp4", signal)
  if (!blob) return null
  const frame = await frameOf(blob, signal)
  return frame ? { blob: frame.picture, duration: frame.duration } : null
})
