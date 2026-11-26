// Turns Nyx's takes, as ElevenLabs saved them, into the tour's: `node scripts/tour-voice/takes.ts
// <folder>`, where the folder holds one file per line of NARRATION.md, named for its key
// (`start.mp3`, `files.cue.mp3`). Each is trimmed of the silence around it, brought to one
// loudness, and written as a small mono MP3 to `frontend/tour/src/voice/<key>.mp3`, which the tour plays as the
// line's caption shows. It says which lines have no take yet, which files are no line's, and
// which takes run longer than their box may stay.
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"

const folder = process.argv[2]
if (folder === undefined) {
  console.error("Usage: node scripts/tour-voice/takes.ts <folder of takes>")
  process.exit(1)
}

const tour = join(import.meta.dirname, "..", "..", "frontend", "tour")
const out = join(tour, "src", "voice")

// The lines' keys, as the script lists them: narration.test.ts holds it to the tour's own lines.
const keys = [
  ...readFileSync(join(tour, "NARRATION.md"), "utf8").matchAll(/^- \[[ x]\] `([^`]+)`: /gm),
].map(([, key]) => key!)

// How long a take may run: a cue gives way as soon as its subject shows, and the first line's box
// stays 3 s.
const longest = (key: string): number => (key === "start" ? 2.7 : key.endsWith(".cue") ? 2.2 : 3.5)

const sounds = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"])
const files = readdirSync(folder).filter((name) => sounds.has(extname(name).toLowerCase()))
const keyOf = (name: string): string => name.slice(0, -extname(name).length)

// The silence ElevenLabs leaves around a take, trimmed from both ends, then one loudness for all,
// a little under the skits' (they're mastered for feeds; this plays beside an app).
const filter = [
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05",
  "areverse",
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08",
  "areverse",
  "loudnorm=I=-18:TP=-1.5:LRA=11",
].join(",")

mkdirSync(out, { recursive: true })
const missing: string[] = []
const long: string[] = []
for (const key of keys) {
  const file = files.find((name) => keyOf(name) === key)
  if (file === undefined) {
    missing.push(key)
    continue
  }
  const target = join(out, `${key}.mp3`)
  execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-i",
    join(folder, file),
    "-af",
    filter,
    "-ac",
    "1",
    "-ar",
    "44100",
    "-b:a",
    "64k",
    "-map_metadata",
    "-1",
    target,
  ])
  const seconds = Number(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      target,
    ]).toString(),
  )
  console.log(`${key}: ${seconds.toFixed(2)} s`)
  if (seconds > longest(key))
    long.push(`${key} (${seconds.toFixed(2)} s, at most ${longest(key)} s)`)
}

const strays = files.filter((name) => !keys.includes(keyOf(name)))
if (missing.length > 0) console.log(`\nNo take yet: ${missing.join(", ")}`)
if (strays.length > 0) console.log(`\nNo line's: ${strays.join(", ")}`)
if (long.length > 0) console.log(`\nLonger than their box may stay: ${long.join(", ")}`)
