import { z } from "zod"

// Voice input: speech typed into terminals, transcribed on this machine by an engine and
// a model the person installs from Preferences. `turbo` is accurate in many languages but
// wants a GPU; `small` is quicker on a CPU and less accurate.
export const voiceModel = z.enum(["turbo", "small"])
// The language spoken: `auto` to detect it, or a code Whisper knows, such as "en" or "pl".
export const voiceLanguage = z.string().regex(/^(auto|[a-z]{2,3})$/)

/** Voice clips are 16 kHz mono 16-bit little-endian PCM. */
export const voiceSampleRate = 16_000
/** The longest clip, in seconds. */
export const maxVoiceSeconds = 120
/**
 * The longest part of a clip, in base64 characters: 144 KiB of audio, so a whole
 * `voice.record` call fits in `maxWebSocketMessageBytes`.
 */
export const maxVoicePartLength = 196_608

// Why an addon is installing: the person asked, or the app updated and brought a new engine,
// which is fetched alone and needs nothing from the person.
const installOrigin = z.enum(["person", "update"])

// What an install is doing: downloading the engine or the model, or checking that they
// transcribe, with the bytes received of the step's total.
const voiceInstall = z.strictObject({
  origin: installOrigin,
  model: voiceModel,
  step: z.enum(["engine", "model", "check"]),
  received: z.int().nonnegative(),
  total: z.int().nonnegative(),
})

// How the engine did on a test clip after an install: the model checked and how long a clip
// took.
export const voiceCheck = z.strictObject({
  model: voiceModel,
  milliseconds: z.int().nonnegative(),
})

export const voiceState = z.strictObject({
  // Whether this build has an engine for this platform; without one nothing installs.
  available: z.boolean(),
  // The models on disk beside the engine; empty until an install finishes.
  installed: z.array(voiceModel),
  // Whether the person turned voice input on; it needs `model` installed.
  enabled: z.boolean(),
  // Whether the person wants voice input, installed or not: until they turn it off, the
  // app offers it, as a microphone that leads to its install.
  wanted: z.boolean(),
  model: voiceModel,
  // Whether the engine for this build is on disk, which an install skips and an uninstall frees.
  engineInstalled: z.boolean(),
  // The model an install fetches first: turbo, or small where this computer is known not
  // to suit turbo. The person does not choose it.
  aim: voiceModel,
  language: voiceLanguage,
  // Download sizes in bytes: the engine for this platform, and each model.
  sizes: z.strictObject({ engine: z.int().nonnegative(), turbo: z.int(), small: z.int() }),
  installing: voiceInstall.nullable(),
  check: voiceCheck.nullable(),
  // Why the last install, or the engine's update, failed, until the next install, update
  // or removal. A clip that fails to transcribe is its caller's error alone.
  failure: z.string().max(1024).nullable(),
})

// Murmur: a small model that runs on this machine's graphics and writes terminals' titles,
// opt-in from Preferences like voice input. It has one engine and one model.

// What an install is doing: downloading the engine or the model, or checking that they
// describe, with the bytes received of the step's total.
const murmurInstall = z.strictObject({
  step: z.enum(["engine", "model", "check"]),
  received: z.int().nonnegative(),
  total: z.int().nonnegative(),
  // Who started it: the person, or the app's update, which fetches a new engine alone.
  origin: installOrigin,
})

// The device that passed the check after an install: its name, whether it is an
// integrated GPU, and how long the test description took.
export const murmurCheck = z.strictObject({
  device: z.string().max(256),
  integrated: z.boolean(),
  milliseconds: z.int().nonnegative(),
})

export const murmurState = z.strictObject({
  // Whether this build has an engine for this platform; without one nothing installs.
  available: z.boolean(),
  // Whether the engine and the model are on disk; false until an install finishes.
  installed: z.boolean(),
  // Whether the model is on disk though murmur isn't installed (the engine is gone): a
  // verdict kept a model that was downloaded earlier, so trying again fetches the engine
  // alone. The person can remove it with an uninstall.
  kept: z.boolean(),
  // Whether the person turned murmur on; it needs to be installed.
  enabled: z.boolean(),
  // Whether the person wants murmur, installed or not: until they turn it off, the app
  // offers it.
  wanted: z.boolean(),
  // Download sizes in bytes: the engine for this platform, and the model.
  sizes: z.strictObject({ engine: z.int().nonnegative(), model: z.int().nonnegative() }),
  installing: murmurInstall.nullable(),
  // Null until a check passes.
  check: murmurCheck.nullable(),
  // Why this computer can't run murmur, technical and for a details view, once it is known:
  // the desktop app saw only software rendering (`source: "host"`), or an install found no graphics
  // device that runs the model, or the engine could not load a library it needs
  // (`source: "check"`; the engine and the downloads are then removed, but a model that was
  // on disk before that install began stays, see `kept`). Null while nothing says it can't. It
  // is no failure to try again. An install is refused while the app's word holds; a check's
  // verdict stands until another check passes, which installing again runs, and an engine of
  // another build forgets it.
  unsupported: z
    .strictObject({ reason: z.string().max(1024), source: z.enum(["host", "check"]) })
    .nullable(),
  // In how many sessions of the app the one-time offer was shown; the app stops offering after
  // three, whether or not they answered.
  offers: z.int().nonnegative(),
  // Why murmur is not working, in words for the person: the last install or engine update
  // that failed (network, disk), until the next install, update or removal; the device it was
  // checked on being gone (the check is then null, and Try again installs just the check); a
  // worker that would not start; or the engine failing three jobs in a row (the check stands)
  // until a job succeeds. Turning murmur on clears the last two.
  failure: z.string().max(1024).nullable(),
  // The part of `failure` that is murmur stopping while installed: the engine failing three
  // jobs in a row, or its worker not starting, until a job succeeds. Null otherwise, also
  // for an install or update that failed and for a device that went away. Murmur's jobs
  // retry by themselves, so there is nothing to retry.
  stopped: z.string().max(1024).nullable(),
})

export const murmurSettings = z.strictObject({
  enabled: z.boolean(),
})

/**
 * Why voice input cannot be used, as the data of VOICE_UNAVAILABLE: this build has no
 * engine for the platform, voice input is off or its model is not installed, it is being
 * removed, its engine is updating with none usable, or its engine is missing.
 */
export const voiceUnavailable = z.strictObject({
  reason: z.enum(["unavailable", "off", "removing", "updating", "missing"]),
})

export const voiceSettings = z.strictObject({
  enabled: z.boolean(),
  model: voiceModel,
  language: voiceLanguage,
})

// What the person changes of the settings: the model is the install's choice, not theirs.
export const voiceChange = voiceSettings.omit({ model: true }).partial()

export const voiceTranscript = z.strictObject({
  text: z.string(),
  // The language the engine heard, as a code such as "en".
  language: z.string(),
})

export type VoiceModel = z.infer<typeof voiceModel>
export type VoiceInstall = z.infer<typeof voiceInstall>
export type VoiceCheck = z.infer<typeof voiceCheck>
export type VoiceState = z.infer<typeof voiceState>
export type VoiceUnavailable = z.infer<typeof voiceUnavailable>
export type VoiceSettings = z.infer<typeof voiceSettings>
export type VoiceChange = z.infer<typeof voiceChange>
export type VoiceTranscript = z.infer<typeof voiceTranscript>
export type MurmurInstall = z.infer<typeof murmurInstall>
export type MurmurCheck = z.infer<typeof murmurCheck>
export type MurmurState = z.infer<typeof murmurState>
export type MurmurSettings = z.infer<typeof murmurSettings>
