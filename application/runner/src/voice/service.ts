import { access, readdir, readFile, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import {
  voiceSampleRate,
  type VoiceCheck,
  type VoiceInstall,
  type VoiceModel,
  type VoiceSettings,
  type VoiceState,
  type VoiceTranscript,
  type VoiceUnavailable,
} from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { VoiceSettingsChange } from "../workspaces/store.js"
import {
  catalog as pinned,
  readManifest,
  recommend,
  type Catalog,
  type Manifest,
} from "./catalog.js"
import { Clips } from "./clips.js"
import { download, DownloadError, locate } from "./download.js"
import {
  Engine,
  EngineError,
  engineFolder,
  engineInterface,
  engineProgram,
  enginesIn,
  unpack,
  type EngineConfig,
  type Launch,
} from "./engine.js"
import { wav } from "./wav.js"

/** Where the runner keeps voice input's settings. */
export type VoiceSettingsStore = {
  voiceSettings(): VoiceSettings
  saveVoiceSettings(settings: VoiceSettingsChange): void
  voiceEnabledChoice(): boolean | undefined
  /** The last install's check, which outlives a restart; `null` when none passed. */
  voiceCheck(): VoiceCheck | null
  saveVoiceCheck(check: VoiceCheck | null): void
}

export type VoiceOptions = {
  /** The engine's manifest, `engine.json`; without one voice input is unavailable. */
  readonly engine?: string | undefined
  /** Where the engine's archive is: an https URL ending in `/`, or a folder. Beside the manifest by default. */
  readonly source?: string | undefined
  /** Where the engine and models are installed. */
  readonly directory: string
  /** The models to download; those Novadeck ships unless a test brings its own. */
  readonly catalog?: Catalog
  readonly launch?: Launch
  readonly idleMs?: number
  /** How long each of the check's transcriptions may take after an install. */
  readonly checkMs?: number
  readonly now?: () => number
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

const unavailable = (reason: VoiceUnavailable["reason"], message: string): DomainError =>
  new DomainError("VOICE_UNAVAILABLE", message, { reason })

const aborted = (error: unknown): boolean => error instanceof Error && error.name === "AbortError"

const explain = (error: unknown): string => {
  if (error instanceof DownloadError || error instanceof EngineError) return error.message
  if (error instanceof Error && "code" in error && error.code === "ENOSPC")
    return "There is not enough disk space to install voice input."
  return `Voice input could not be installed: ${error instanceof Error ? error.message : String(error)}`
}

type Watch = { readonly owner: string; finished: boolean; wake: (() => void) | undefined }

// How often progress reaches watchers, at most.
const progressMs = 100
// How long after a failed engine update the next clip tries it again, as when the
// network was down: soon enough to recover by itself, not once per clip.
export const updateRetryMs = 60_000

/**
 * Voice input: the engine and models people install, the settings, the clips being
 * recorded, and the transcribing of them. Everything on this machine.
 */
export class Voice {
  private readonly directory: string
  private readonly source: string | undefined
  private readonly catalog: Catalog
  private readonly engine: Engine
  private readonly clips: Clips
  private manifest: Manifest | undefined
  private installed: VoiceModel[] = []
  // Whether the manifest's engine is unpacked; models alone still count as installed, as
  // an update of the app brings a new engine that is fetched without a reinstall.
  private engineReady = false
  // The engine folder clips are transcribed with: the manifest's, or while that one is
  // fetched an older one that still runs, so dictation goes on through an update.
  private engineDir: string | undefined
  // Loading the saved state at start, which the first call to use it waits for.
  private loading: Promise<void> = Promise.resolve()
  // An engine update that failed is not tried again by every clip; installing retries it.
  // When the last engine update failed: another waits a minute, not for every clip.
  private updateFailedAt: number | undefined
  private uninstalling = false
  private installing: VoiceInstall | null = null
  private failure: string | null = null
  // The model whose install the failure is of; none for an engine update's.
  private failureModel: VoiceModel | undefined
  private running:
    | { readonly done: Promise<void>; readonly controller: AbortController }
    | undefined
  private readonly watchers = new Set<Watch>()
  private version = 0
  private closed = false

  constructor(
    private readonly settings: VoiceSettingsStore,
    private readonly options: VoiceOptions,
  ) {
    this.directory = options.directory
    this.source =
      options.source ?? (options.engine === undefined ? undefined : dirname(options.engine))
    this.catalog = options.catalog ?? pinned
    this.engine = new Engine({
      ...(options.launch && { launch: options.launch }),
      ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
    })
    this.clips = new Clips(options.now)
  }

  private clock(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Reads the manifest and what is on disk again, as either may have changed. Writes nothing. */
  async refresh(): Promise<void> {
    const manifest = await readManifest(this.options.engine)
    const models: VoiceModel[] = []
    if (manifest)
      for (const model of ["turbo", "small"] as const)
        if ((await exists(this.modelPath(model))) && (await exists(this.vadPath())))
          models.push(model)
    const current = manifest && engineFolder(this.directory, manifest.sha256)
    const ready = current !== undefined && (await exists(join(current, engineProgram)))
    this.manifest = manifest
    this.installed = models
    this.engineReady = ready
    this.engineDir =
      manifest === undefined
        ? undefined
        : ready
          ? current
          : await this.olderEngine(manifest.interface)
  }

  /**
   * An engine of an earlier build that is still unpacked and speaks `wanted`, the
   * interface this runner launches engines with, if there is one.
   */
  private async olderEngine(wanted: number): Promise<string | undefined> {
    const root = enginesIn(this.directory)
    // Folders being unpacked start with a dot and are not whole yet.
    const entries = (await readdir(root).catch(() => [])).filter((entry) => !entry.startsWith("."))
    for (const entry of entries.toSorted()) {
      // eslint-disable-next-line no-await-in-loop -- Stops at the first that runs.
      if (await this.runs(join(root, entry), wanted)) return join(root, entry)
    }
    return undefined
  }

  /** Whether the engine unpacked in `folder` has its program and speaks `wanted`. */
  private async runs(folder: string, wanted: number): Promise<boolean> {
    return (await exists(join(folder, engineProgram))) && (await engineInterface(folder)) === wanted
  }

  /**
   * `refresh`, and the saved state it implies: a chosen model that went missing gives way
   * to one that is there, so turning voice input on, and the model the card shows as
   * chosen, both mean a model that exists.
   */
  async load(): Promise<void> {
    await this.refresh()
    const chosen = this.settings.voiceSettings().model
    const remaining = this.installed[0]
    if (!this.installed.includes(chosen) && remaining !== undefined)
      this.settings.saveVoiceSettings({ model: remaining })
  }

  /** Loads the saved state at start; the first record, transcription or watch waits for it. */
  start(): void {
    this.loading = this.load().catch(() => {})
  }

  /** Answers once the state loaded at start is there. */
  ready(): Promise<void> {
    return this.loading
  }

  state(): VoiceState {
    const settings = this.settings.voiceSettings()
    const check = this.settings.voiceCheck()
    return {
      available: this.manifest !== undefined,
      installed: this.installed,
      // Models that went missing cannot be used, whatever the person once chose.
      enabled: settings.enabled && this.installed.includes(settings.model),
      wanted: this.settings.voiceEnabledChoice() !== false,
      model: settings.model,
      language: settings.language,
      sizes: {
        engine: this.manifest?.size ?? 0,
        turbo: this.catalog.models.turbo.size + this.catalog.vad.size,
        small: this.catalog.models.small.size + this.catalog.vad.size,
      },
      installing: this.installing,
      // A model that is gone takes its check with it, as when its files were deleted by hand.
      check: check !== null && this.installed.includes(check.model) ? check : null,
      failure: this.failure,
    }
  }

  /** The state now, then again after each change, until `signal` aborts or the owner is released. */
  async *watch(owner: string, signal?: AbortSignal): AsyncGenerator<VoiceState> {
    this.assertOpen()
    await this.ready()
    // The runner may have closed while the saved state loaded.
    this.assertOpen()
    await this.refresh()
    this.updateEngine()
    const watch: Watch = { owner, finished: false, wake: undefined }
    this.watchers.add(watch)
    const stop = () => {
      watch.finished = true
      watch.wake?.()
    }
    signal?.addEventListener("abort", stop, { once: true })
    if (signal?.aborted) stop()
    try {
      let seen = -1
      while (!watch.finished) {
        if (seen !== this.version) {
          seen = this.version
          yield this.state()
          continue
        }
        // eslint-disable-next-line no-await-in-loop -- Wait for the next change.
        await new Promise<void>((resolve) => {
          watch.wake = resolve
        })
      }
    } finally {
      signal?.removeEventListener("abort", stop)
      this.watchers.delete(watch)
    }
  }

  /** Ends an owner's watch streams, as its connection goes. */
  release(owner: string): void {
    this.clips.release(owner)
    for (const watch of this.watchers)
      if (watch.owner === owner) {
        watch.finished = true
        watch.wake?.()
      }
  }

  /** Starts installing `model`, with the engine if it is missing; `settled` waits for the end. */
  async install(model: VoiceModel): Promise<void> {
    this.assertOpen()
    if (this.running) throw new DomainError("CONFLICT", "Voice input is already installing.")
    if (this.uninstalling)
      throw new DomainError("CONFLICT", "Voice input is being removed. Install it afterwards.")
    await this.refresh()
    if (this.manifest === undefined)
      throw unavailable("unavailable", "Voice input is not available in this build.")
    // `refresh` yielded: another install may have started.
    if (this.running || this.uninstalling)
      throw new DomainError("CONFLICT", "Voice input is already installing.")
    const controller = new AbortController()
    this.updateFailedAt = undefined
    this.failure = null
    this.settings.saveVoiceCheck(null)
    // Installing it at all says the person wants it, whatever they chose before: an off
    // from then on, during the install too, still holds.
    if (this.installed.length === 0) this.settings.saveVoiceSettings({ enabled: null })
    this.installing = { model, step: "engine", received: 0, total: this.manifest.size }
    this.changed()
    this.running = { controller, done: this.run(model, this.manifest, controller.signal) }
  }

  /**
   * Fetches the engine of this build alone when voice input is on with its models but
   * the engine is an older one or missing, as after an update of the app. It shows as an
   * install at the engine step, and a failure lands in `failure`.
   */
  private updateEngine(): void {
    const { manifest } = this
    const settings = this.settings.voiceSettings()
    if (
      this.closed ||
      this.running ||
      this.uninstalling ||
      (this.updateFailedAt !== undefined && this.clock() - this.updateFailedAt < updateRetryMs) ||
      this.engineReady ||
      manifest === undefined ||
      !settings.enabled ||
      !this.installed.includes(settings.model)
    )
      return
    const controller = new AbortController()
    this.failure = null
    this.installing = { model: settings.model, step: "engine", received: 0, total: manifest.size }
    this.changed()
    this.running = {
      controller,
      done: this.run(settings.model, manifest, controller.signal, true),
    }
  }

  /** Stops an install, and answers once it has. */
  async cancel(): Promise<void> {
    this.running?.controller.abort()
    await this.settled()
  }

  /** Answers when no install is running. */
  async settled(): Promise<void> {
    await this.running?.done
  }

  /** Removes the engine and the models, and turns voice input off. */
  async uninstall(): Promise<void> {
    this.assertOpen()
    if (this.uninstalling)
      throw new DomainError("CONFLICT", "Voice input is already being removed.")
    // Held until the end, so nothing installs, records or starts the engine from files
    // that are going.
    this.uninstalling = true
    try {
      await this.cancel()
      // Off first: a removal that fails halfway must not leave voice input on. Off by
      // choice, as removing it says the person doesn't want it: the app stops offering it,
      // and only an install turns it on again.
      this.settings.saveVoiceSettings({ enabled: false })
      this.changed()
      // The engine's program is in use until it has exited, which Windows will not delete.
      await this.engine.stop()
      // The folder itself may be one the person chose, so only what is in it goes.
      const entries = await readdir(this.directory).catch(() => [])
      try {
        await Promise.all(
          entries.map((entry) => rm(join(this.directory, entry), { recursive: true, force: true })),
        )
      } catch (error) {
        throw new DomainError(
          "VOICE_FAILED",
          `Voice input could not be removed: ${error instanceof Error ? error.message : String(error)}. Close anything using the files in ${this.directory} and try again.`,
        )
      } finally {
        await this.load()
      }
      this.settings.saveVoiceCheck(null)
      this.failure = null
    } finally {
      this.uninstalling = false
      this.changed()
    }
  }

  async set(change: VoiceSettingsChange): Promise<void> {
    this.assertOpen()
    await this.ready()
    // The runner may have closed while the saved state loaded.
    this.assertOpen()
    if (this.uninstalling) throw new DomainError("CONFLICT", "Voice input is being removed.")
    const model = change.model ?? this.settings.voiceSettings().model
    if (change.model !== undefined && !this.installed.includes(change.model))
      throw new DomainError("CONFLICT", `The ${change.model} model is not installed.`)
    // Turned on before any install, it is wanted, and the install that follows turns it on.
    if (change.enabled === true && this.installed.length === 0) {
      this.settings.saveVoiceSettings({ ...change, enabled: null })
      this.changed()
      return
    }
    if (change.enabled === true && !this.installed.includes(model))
      throw new DomainError("CONFLICT", `The ${model} model is not installed.`)
    // A check that ran out of time says to turn voice input on to try dictating anyway,
    // which is the end of that failure; another model's, or the engine's, stays.
    if (change.enabled === true && this.failure !== null && this.failureModel === model) {
      this.failure = null
      this.failureModel = undefined
    }
    this.settings.saveVoiceSettings(change)
    // The engine holds one model, so the next clip starts it with the new one.
    if (change.model !== undefined) void this.engine.stop()
    this.changed()
  }

  /** Adds audio to a clip. The first part of a clip starts the engine, to have it ready by its end. */
  async record(owner: string, clipId: string, offset: number, data: string): Promise<void> {
    this.assertOpen()
    await this.ready()
    this.assertOpen()
    const config = this.configuration()
    if (this.clips.write(owner, clipId, offset, Buffer.from(data, "base64")))
      this.engine.start(config).catch(() => {
        // `transcribe` starts it again and reports why it cannot.
      })
  }

  discard(owner: string, clipId: string): void {
    this.clips.discard(owner, clipId)
  }

  async transcribe(owner: string, clipId: string, prompt?: string): Promise<VoiceTranscript> {
    this.assertOpen()
    await this.ready()
    this.assertOpen()
    const config = this.configuration()
    const pcm = this.clips.get(owner, clipId)
    if (pcm === undefined) throw new DomainError("NOT_FOUND", "That recording is gone.")
    const { language } = this.settings.voiceSettings()
    // Less than a hundredth of a second holds no word, and the engine rejects an empty file.
    if (pcm.length < voiceSampleRate / 50) {
      this.clips.discard(owner, clipId)
      return { text: "", language: language === "auto" ? "" : language }
    }
    try {
      const result = await this.engine.transcribe(config, wav(pcm), { language, prompt })
      this.clips.discard(owner, clipId)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The engine may be what went wrong with a first clip; keep the clip for another try.
      // Only the caller hears of it: the shared failure is for the install and the engine.
      throw new DomainError("VOICE_FAILED", message.slice(0, 1024))
    }
  }

  /** Cancels an install and ends the engine, as the runner closes. */
  async close(): Promise<void> {
    this.closed = true
    this.running?.controller.abort()
    await this.settled()
    await this.loading
    await this.engine.close()
    for (const watch of this.watchers) {
      watch.finished = true
      watch.wake?.()
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new DomainError("RUNTIME_CLOSING")
  }

  /** The engine's files, for voice input that is on and installed; VOICE_UNAVAILABLE, saying why, otherwise. */
  private configuration(): EngineConfig {
    const settings = this.settings.voiceSettings()
    if (this.uninstalling) throw unavailable("removing", "Voice input is being removed.")
    if (!this.manifest)
      throw unavailable("unavailable", "Voice input is not available in this build.")
    if (!settings.enabled || !this.installed.includes(settings.model))
      throw unavailable("off", "Voice input is not turned on.")
    // An update of the engine is fetched in the background; clips go on with the engine
    // that is there until the new one is.
    if (!this.engineReady) this.updateEngine()
    if (this.engineDir === undefined) {
      // A dictation does not wait for the download, which takes minutes: it is told, and
      // the install in the state shows how far the engine is.
      throw this.running
        ? unavailable("updating", "Updating the voice engine. Try again when it is done.")
        : unavailable(
            "missing",
            this.failure ?? "The voice engine is missing. Install voice input again.",
          )
    }
    return {
      ...this.engineConfig(this.manifest, settings.model, settings.language),
      folder: this.engineDir,
    }
  }

  private engineConfig(manifest: Manifest, model: VoiceModel, language: string): EngineConfig {
    return {
      folder: engineFolder(this.directory, manifest.sha256),
      model: this.modelPath(model),
      vad: this.vadPath(),
      language,
    }
  }

  private modelPath(model: VoiceModel): string {
    return join(this.directory, "models", basename(this.catalog.models[model].url))
  }

  private vadPath(): string {
    return join(this.directory, "models", basename(this.catalog.vad.url))
  }

  private changed(): void {
    this.version += 1
    for (const watch of this.watchers) watch.wake?.()
  }

  /** Updates the install's step, telling watchers at most ten times a second unless `force`. */
  private progress(install: VoiceInstall, force = false): void {
    this.installing = install
    const now = Date.now()
    if (!force && now - this.lastProgress < progressMs) return
    this.lastProgress = now
    this.changed()
  }

  private lastProgress = 0

  private async run(
    model: VoiceModel,
    manifest: Manifest,
    signal: AbortSignal,
    engineOnly = false,
  ): Promise<void> {
    // What was chosen as the install began, before it or a refresh changes that, and
    // whether anything was installed then.
    const before = { settings: this.settings.voiceSettings() }
    try {
      const folder = engineFolder(this.directory, manifest.sha256)
      if (!(await exists(join(folder, engineProgram)))) {
        const total = manifest.size
        this.progress({ model, step: "engine", received: 0, total }, true)
        if (this.source === undefined)
          throw new DownloadError("This build has nowhere to download the engine from.")
        const archive = join(this.directory, "downloads", manifest.file)
        await download({
          from: locate(this.source, manifest.file),
          to: archive,
          sha256: manifest.sha256,
          signal,
          progress: (received) => this.progress({ model, step: "engine", received, total }),
        })
        // Unpacking removes the engines this one replaces; none may be running, and no
        // clip may start one from a folder that is going. Clips are told to wait until
        // the new engine is there, which the refresh after the unpacking, or after a
        // failure, settles.
        this.engineDir = undefined
        await this.engine.stop()
        await unpack(archive, this.directory, manifest.sha256, manifest.interface, signal)
        await rm(archive, { force: true })
        await this.refresh()
      }
      if (engineOnly) return
      await this.fetchModel(model, signal)
      this.progress({ model, step: "check", received: 0, total: 0 }, true)
      const check = await this.measure(model, manifest, signal)
      // The model checked out, so it is the one used, and voice input is on, as the person
      // installed it to use it, unless they turned it off themselves, before another model's
      // install or during this one.
      this.settings.saveVoiceSettings({
        model,
        enabled: this.settings.voiceEnabledChoice() !== false,
      })
      await this.load()
      this.settings.saveVoiceCheck(check)
    } catch (error) {
      // Cancelling is the person's choice, not a failure.
      if (!signal.aborted && !aborted(error)) {
        this.failure = explain(error).slice(0, 1024)
        this.failureModel = engineOnly ? undefined : model
        this.updateFailedAt = engineOnly ? this.clock() : undefined
      }
      // What finished stays: a model that downloaded shows as installed, to turn on or
      // check again, rather than looking as if it had to download again.
      await this.load().catch(() => {})
      // A model that went unchecked never replaces one in use: it is chosen only when the
      // one chosen before is not there to use, as on a first install, and stays off until
      // turned on, even if the load above already chose it for a model gone missing. Off
      // by choice only if the person chose it; otherwise a later check turns it on.
      const chosen = before.settings.model
      if (!engineOnly && this.installed.includes(model) && !this.installed.includes(chosen))
        this.settings.saveVoiceSettings({
          model,
          enabled: this.settings.voiceEnabledChoice() === false ? false : null,
        })
    } finally {
      this.installing = null
      this.running = undefined
      this.changed()
    }
  }

  /** Downloads the model and the voice activity model beside it, those not already there. */
  private async fetchModel(model: VoiceModel, signal: AbortSignal): Promise<void> {
    const parts = [
      { artifact: this.catalog.models[model], path: this.modelPath(model) },
      { artifact: this.catalog.vad, path: this.vadPath() },
    ]
    const total = parts.reduce((sum, part) => sum + part.artifact.size, 0)
    this.progress({ model, step: "model", received: 0, total }, true)
    let done = 0
    for (const { artifact, path } of parts) {
      // One file after the other, so the bytes received add up.
      // eslint-disable-next-line no-await-in-loop -- Sequential on purpose.
      if (!(await exists(path)))
        // eslint-disable-next-line no-await-in-loop -- Sequential on purpose.
        await download({
          from: artifact.url,
          to: path,
          sha256: artifact.sha256,
          signal,
          progress: (received) =>
            this.progress({ model, step: "model", received: done + received, total }),
        })
      done += artifact.size
    }
  }

  /** Transcribes the engine's test clip with `model`, to see how this machine does. */
  private async measure(
    model: VoiceModel,
    manifest: Manifest,
    signal: AbortSignal,
  ): Promise<VoiceCheck> {
    const config = this.engineConfig(manifest, model, "en")
    // Its own engine, so a dictation's model is neither swapped out for this one nor
    // ended by the check, and a check never fails because a clip came in.
    const engine = new Engine({ ...(this.options.launch && { launch: this.options.launch }) })
    const stop = () => void engine.stop()
    signal.addEventListener("abort", stop, { once: true })
    try {
      await engine.start(config)
      // Cancelling may come while the engine starts, which nothing interrupts.
      signal.throwIfAborted()
      const clip = await readFile(join(config.folder, "check.wav")).catch(() => {
        throw new EngineError("The engine's archive has no test clip.")
      })
      // A check that never ends would hold the install; one this slow means the model
      // is too much for this computer anyway.
      const timeoutMs = this.options.checkMs ?? 60_000
      const run = () =>
        engine.transcribe(config, clip, { language: "en", timeoutMs }).catch((error) => {
          throw new EngineError(
            `The ${model} model did not transcribe a short test clip within ` +
              `${Math.round(timeoutMs / 1000)} s. ${model === "turbo" ? "Try Small, which is faster, or " : ""}` +
              `turn voice input on to try dictating anyway. (${explain(error)})`,
          )
        })
      // The first run loads the voice model and warms up the GPU, which later clips do not pay for.
      await run()
      signal.throwIfAborted()
      const started = performance.now()
      const result = await run()
      const milliseconds = Math.round(performance.now() - started)
      if (result.text === "")
        throw new EngineError("The engine ran but heard nothing in its test clip.")
      const gpu = engine.gpu ?? false
      return { model, milliseconds, gpu, recommended: recommend({ gpu, milliseconds }) }
    } finally {
      signal.removeEventListener("abort", stop)
      await engine.close()
    }
  }
}
