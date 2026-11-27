// Turns Nyx's takes, as ElevenLabs saved them, into the tour's: `node scripts/tour-voice/takes.ts
// <folder>`, where the folder holds one file per line of NARRATION.md, named for its key
// (`start.mp3`, `files.cue.mp3`). Each is trimmed of the silence around it, brought to one
// loudness, and written as a small mono MP3 to `frontend/tour/src/voice/<key>.mp3`, which the tour plays as the
// line's caption shows. It says which lines have no take yet, which files are no line's, and
// which takes run longer than their box stays.
import { execFileSync, spawnSync } from "node:child_process"
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

// How long a take may run where its box stays a set time: `start` and `finish` hold 4 s
// (`lineMs` in steps.ts), and anything longer is cut off by the next box. Every other box stays
// until the person or the agents move the tour on, and a cue gives way, mid-word if need be, as
// soon as its subject shows: that's meant.
const held = new Set(["start", "finish"])
const longest = (key: string): number => (held.has(key) ? 3.9 : Number.POSITIVE_INFINITY)

const sounds = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"])
const files = readdirSync(folder).filter((name) => sounds.has(extname(name).toLowerCase()))
const keyOf = (name: string): string => name.slice(0, -extname(name).length)

// The silence ElevenLabs leaves around a take, trimmed from both ends, and its peaks evened.
const trim = [
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05",
  "areverse",
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08",
  "areverse",
  // A soft limit on the odd loud scoff or snap first, so one peak doesn't hold a quiet take down.
  "alimiter=limit=0.35:attack=5:release=60:level=false",
].join(",")

// One loudness for all, a little under the skits' (they're mastered for feeds; this plays beside
// an app), in two passes: one pass guesses on a take this short, and her takes would come out
// a few decibels apart.
const loudness = "I=-18:TP=-1.5:LRA=11"
const measured = (input: string): Record<string, string> => {
  // ffmpeg prints what it measured on stderr, after its own lines.
  const { stderr } = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      input,
      "-af",
      `${trim},loudnorm=${loudness}:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  )
  const from = stderr.lastIndexOf("{")
  return JSON.parse(stderr.slice(from, stderr.indexOf("}", from) + 1))
}
const filterFor = (input: string): string => {
  const m = measured(input)
  return `${trim},loudnorm=${loudness}:measured_I=${m["input_i"]}:measured_TP=${m["input_tp"]}:measured_LRA=${m["input_lra"]}:measured_thresh=${m["input_thresh"]}:offset=${m["target_offset"]}:linear=true`
}

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
    filterFor(join(folder, file)),
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
if (long.length > 0) console.log(`\nLonger than their box stays: ${long.join(", ")}`)
