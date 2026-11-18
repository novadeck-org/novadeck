// How a video's or a recording's facts read: its format and size, its progress and its time.

const names: Record<string, string> = {
  "video/mp4": "MP4",
  "video/webm": "WebM",
  "video/quicktime": "MOV",
  "video/ogg": "Ogg",
  "video/x-matroska": "MKV",
  "video/x-m4v": "M4V",
  "audio/mpeg": "MP3",
  "audio/mp3": "MP3",
  "audio/wav": "WAV",
  "audio/x-wav": "WAV",
  "audio/wave": "WAV",
  "audio/ogg": "Ogg",
  "audio/opus": "Opus",
  "audio/flac": "FLAC",
  "audio/x-flac": "FLAC",
  "audio/mp4": "M4A",
  "audio/x-m4a": "M4A",
  "audio/aac": "AAC",
  "audio/webm": "WebM",
  "audio/aiff": "AIFF",
  "audio/x-aiff": "AIFF",
}

// A MIME type as the format a person names: "video/mp4" is "MP4".
export const formatName = (mime: string): string =>
  names[mime] ?? (mime.split("/")[1] ?? mime).replace(/^x-/, "").toUpperCase()

const megabytes = (bytes: number): string => {
  const mb = bytes / 1024 / 1024
  return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1)
}

// A size as a peek says it: "12.3 MB", in KB under a megabyte.
export const bytesText = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`

// "MP4 · 12.3 MB".
export const factsText = (mime: string, size: number): string =>
  `${formatName(mime)} · ${bytesText(size)}`

// "Loading 12 of 40 MB", or in KB where the whole is under a megabyte.
export const loadingText = (loaded: number, total: number): string =>
  total < 1024 * 1024
    ? `Loading ${Math.round(loaded / 1024)} of ${Math.max(1, Math.round(total / 1024))} KB`
    : `Loading ${megabytes(loaded)} of ${megabytes(total)} MB`

// A time on a clock: "0:07", "12:30", "1:02:03"; `fine` adds hundredths, "0:07.42", so a
// step of a frame or a cut a moment in shows in it.
export const clock = (seconds: number, fine = false): string => {
  const time = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const whole = Math.floor(time)
  const s = String(whole % 60).padStart(2, "0")
  const m = Math.floor(whole / 60) % 60
  const h = Math.floor(whole / 3600)
  const shown = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
  if (!fine) return shown
  return `${shown}.${String(Math.floor((time - whole) * 100)).padStart(2, "0")}`
}
