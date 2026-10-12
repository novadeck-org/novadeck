import { execFile } from "node:child_process"
import { freemem } from "node:os"
import { dirname, join } from "node:path"

import type { MurmurCheck, MurmurInstall, MurmurSettings, MurmurState } from "@novadeck/protocol"

import type { Activity } from "../engines/activity.js"
import { DownloadError, download } from "../engines/download.js"
import { aborted, engineStatus, fetchEngine, removeContents } from "../engines/install.js"
import { readManifest, type Artifact, type Manifest } from "../engines/manifest.js"
import { modelFile as modelPathOf, pruneModels } from "../engines/models.js"
import {
  Server,
  runEngineOnce,
  token,
  type Launch,
  type Running,
  type ServerSpec,
} from "../engines/server.js"
import { EngineError, engineFolder, exists, programFile } from "../engines/unpack.js"
import { Watchers } from "../engines/watchers.js"
import { DomainError } from "../errors.js"
import type { MurmurSettingsChange } from "../workspaces/store.js"
import type { Description, Describer, Digest } from "./describer.js"
import { parseDescription } from "./description.js"
import { candidates, parseDevices, type Device } from "./devices.js"
import { parseVmStat } from "./memory.js"
import { Preparer } from "./prepare.js"
import { responseFormat, type Message } from "./prompt.js"

/** Where the runner keeps murmur's settings. */
export type MurmurSettingsStore = {
  murmurSettings(): MurmurSettings
  saveMurmurSettings(settings: MurmurSettingsChange): void
  murmurEnabledChoice(): boolean | undefined
  /** The last install's check, which outlives a restart; `null` when none passed. */
  murmurCheck(): MurmurCheck | null
  saveMurmurCheck(check: MurmurCheck | null): void
}

/** The one model murmur uses, pinned by the commit of its repository. */
export const pinnedModel: Artifact = {
  url: "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf",
  sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
  size: 1280835840,
}

export type MurmurOptions = {
  /** The engine's manifest, `engine.json`; without one murmur is unavailable. */
  readonly engine?: string | undefined
  /** Where the engine's archive is: an https URL ending in `/`, or a folder. Beside the manifest by default. */
  readonly source?: string | undefined
  /** Where the engine and the model are installed. */
  readonly directory: string
  /** The model to download; the one Novadeck ships unless a test brings its own. */
  readonly model?: Artifact
  /** What voice input is doing: murmur gives way while it is busy. */
  readonly voice?: Activity
  readonly launch?: Launch
  /** How long the model stays loaded once nothing needs it. */
  readonly idleMs?: number
  /** How long each device may take for the install check's test description. */
  readonly checkMs?: number
  /** How long redacting a digest may take before it is given up on. */
  readonly prepareMs?: number
  /** The script of the thread that redacts digests; for a test to bring its own. */
  readonly prepareScript?: URL
  /** How long a job waits before it looks again at voice and memory. */
  readonly retryMs?: number
  /** How long after a failed job the next is refused, and how it grows with each failure in a row. */
  readonly backoffMs?: number
  /** Memory below which jobs wait, in MiB. */
  readonly minFreeMiB?: number
  /** The computer's free memory in bytes. */
  readonly freeMemory?: () => number
  /** How long one description may take before the engine is taken to be stuck. */
  readonly requestMs?: number
  /** How long the engine may take to start and load the model. */
  readonly startMs?: number
  readonly now?: () => number
}

const needsGpu = "Murmur needs a working GPU, and this computer has none it can use."

const unavailable = (message: string): DomainError => new DomainError("CONFLICT", message)

const explain = (error: unknown): string => {
  if (error instanceof DownloadError || error instanceof EngineError) return error.message
  if (error instanceof Error && "code" in error && error.code === "ENOSPC")
    return "There is not enough disk space to install murmur."
  return `Murmur could not be installed: ${error instanceof Error ? error.message : String(error)}`
}

// Why the worker thread gave no chat for the install check's test terminal.
const workerFailure = {
  unavailable: "Murmur's worker could not start.",
  late: "Murmur's worker took too long to prepare the test terminal.",
  failed: "Murmur's worker failed on the test terminal.",
  stopped: "Murmur's worker was stopped.",
} as const

// How long after a failed engine update the next look tries it again.
export const updateRetryMs = 60_000

// What the install check asks: a small, fixed session, the same on every machine.
const checkDigest: Digest = {
  kind: "agent",
  harness: "Claude Code",
  project: "shop",
  folder: "api",
  branch: "task/checkout-retries",
  plan: null,
  folders: ["src/checkout"],
  prompts: ["Add retries with backoff to the payment client, and cover them with tests."],
  reply: "I added the retries in src/checkout/payments.ts. The tests pass. Anything else?",
  summary: null,
  previous: null,
}

type Config = {
  readonly folder: string
  readonly model: string
  /** What `--device` takes. */
  readonly device: string
}

// Nothing is learned from the server's log.
type Facts = Readonly<Record<string, never>>

// llama-server's arguments. Changing these flags, or the HTTP surface murmur relies on
// (`/health`, `/v1/chat/completions`, the key in `LLAMA_API_KEY`), means bumping
// `engineInterface` in application/murmur/scripts/build.ts, so an engine unpacked for the
// old ones is fetched again; whisper's engine has the same rule.
export const serverArguments = (model: string, device: string, port: number): string[] => [
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "-m",
  model,
  "--device",
  device,
  "-ngl",
  "999",
  "-c",
  "4096",
  "-np",
  "1",
  "--reasoning",
  "off",
  "--exit-with-stdin",
]

/** Resolves when `signal` aborts, never when there is none. */
const dropped = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))

const mebibyte = 1024 * 1024

// How long the engine may take to start and load the model, for the server and for a job alike.
const defaultStartMs = 120_000

// macOS counts only never-used pages as free and keeps the rest as cache, so `os.freemem()`
// always looks short there, and Metal's figure in `--list-devices` is per process and never
// short. `vm_stat` tells what can be had; if it can't be read, nothing is held back.
const readVmStat = (signal: AbortSignal | undefined): Promise<number> =>
  new Promise((resolve) => {
    execFile(
      "vm_stat",
      [],
      { timeout: 5000, windowsHide: true, ...(signal && { signal }) },
      (_error, stdout) => resolve(parseVmStat(stdout) ?? Number.POSITIVE_INFINITY),
    )
  })

// Shown, with Try again, when murmur is installed but no check passed: a check that was
// cancelled, or a runner that restarted after one failed.
const unchecked =
  "Murmur is installed but has not passed its check on this computer's GPU yet. Try again."

// How long the model stays loaded once nothing needs it.
const defaultIdleMs = 2 * 60 * 1000

/**
 * Murmur: the engine and model people install, the settings, and the describing of
 * terminals with them, on a GPU of this machine and nowhere else. It gives way to voice
 * input, to a computer short of memory, and to its own failures.
 */
export class Murmur implements Describer {
  private readonly directory: string
  private readonly source: string | undefined
  private readonly model: Artifact
  private readonly server: Server<Config, Facts>
  private readonly preparer: Preparer
  private manifest: Manifest | undefined
  private modelReady = false
  private engineReady = false
  // The engine folder jobs run with: the manifest's, or while that one is fetched an older
  // one that still runs.
  private engineDir: string | undefined
  private loading: Promise<void> = Promise.resolve()
  private updateFailedAt: number | undefined
  private uninstalling = false
  private installing: MurmurInstall | null = null
  private failure: string | null = null
  private running:
    | { readonly done: Promise<void>; readonly controller: AbortController }
    | undefined
  private readonly watchers = new Watchers<MurmurState>()
  private readonly usableListeners = new Set<(usable: boolean) => void>()
  private readonly clearedListeners = new Set<() => void>()
  private lastUsable = false
  private closed = false
  // Jobs run one after another: the tail of the line, and the request now in flight.
  private line: Promise<void> = Promise.resolve()
  private current: AbortController | undefined
  private readonly sleepers = new Set<() => void>()
  private readonly unwatchVoice: (() => void) | undefined
  private failures = 0
  // Engine failures in a row (a crash, or no answer in time): the third is shown on the card.
  private engineStrikes = 0
  // Why jobs fail now, while the check still stands: shown on the card until a job succeeds.
  private runtimeFailure: string | null = null
  private refusedUntil = 0
  // The device the running server was started with, so a warm job doesn't list them again.
  private cached: { readonly device: string } | undefined
  // While the engine being replaced is removed and the new one unpacked, a refresh must not
  // bring the old folder back.
  private replacing = false
  // Counts swaps of the engine, so a look at the disk that spans one is not believed.
  private swaps = 0
  private removal: Promise<void> | undefined
  // Free memory on macOS, read a moment ago.
  private memory: { readonly at: number; readonly bytes: number } | undefined
  // Titles refused for a terminal in a row, and until when it is not asked again.
  private readonly refusals = new Map<string, { count: number; until: number }>()

  constructor(
    private readonly settings: MurmurSettingsStore,
    private readonly options: MurmurOptions,
  ) {
    this.directory = options.directory
    this.source =
      options.source ?? (options.engine === undefined ? undefined : dirname(options.engine))
    this.model = options.model ?? pinnedModel
    this.server = this.makeServer(options.idleMs)
    this.preparer = new Preparer({
      ...(options.prepareMs !== undefined && { deadlineMs: options.prepareMs }),
      ...(options.prepareScript && { script: options.prepareScript }),
      ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
    })
    // Voice has priority: its work stops ours and wakes whatever waits for it to end.
    this.unwatchVoice = options.voice?.watch((busy) => {
      if (busy) this.current?.abort()
      this.wake()
    })
  }

  private makeServer(idleMs: number | undefined): Server<Config, Facts> {
    return new Server(this.spec(), {
      ...(this.options.launch && { launch: this.options.launch }),
      idleMs: idleMs ?? defaultIdleMs,
      // A model on an iGPU loads in seconds; this is for a slow disk.
      startMs: this.options.startMs ?? defaultStartMs,
    })
  }

  private spec(): ServerSpec<Config, Facts> {
    return {
      program: programFile("llama-server"),
      subject: "Murmur",
      health: "/health",
      key: (config) => `${config.folder}\0${config.device}\0${config.model}`,
      prepare: (config, port) => {
        const key = token()
        return {
          args: serverArguments(config.model, config.device, port),
          // In the environment, where no one lists it as they would an argument.
          env: { LLAMA_API_KEY: key },
          headers: { authorization: `Bearer ${key}` },
        }
      },
      facts: () => ({}),
    }
  }

  private clock(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Reads the manifest and what is on disk again, as either may have changed. Writes nothing. */
  async refresh(): Promise<void> {
    const swaps = this.swaps
    const manifest = await readManifest(this.options.engine)
    const { ready, folder } = await engineStatus(
      this.directory,
      manifest,
      programFile("llama-server"),
    )
    const modelReady = manifest !== undefined && (await exists(this.modelPath()))
    // A swap of the engine began or ended meanwhile: what was read may be of the old one.
    if (this.swaps !== swaps || this.replacing) return
    this.modelReady = modelReady
    this.manifest = manifest
    this.engineReady = ready
    this.engineDir = folder
  }

  /** Loads the saved state at start; the first watch waits for it. */
  start(): void {
    this.loading = this.refresh()
      .catch(() => {})
      // Whoever waits for murmur to be usable hears it is, once the saved state is read.
      .then(() => this.changed())
  }

  ready(): Promise<void> {
    return this.loading
  }

  private installed(): boolean {
    return this.modelReady && this.engineDir !== undefined
  }

  state(): MurmurState {
    const installed = this.installed()
    const check = installed ? this.settings.murmurCheck() : null
    return {
      available: this.manifest !== undefined,
      installed,
      enabled: this.settings.murmurSettings().enabled && installed,
      wanted: this.settings.murmurEnabledChoice() !== false,
      sizes: { engine: this.manifest?.size ?? 0, model: this.model.size },
      installing: this.installing,
      check,
      failure:
        this.failure ??
        this.runtimeFailure ??
        (installed && check === null && !this.installing ? unchecked : null),
    }
  }

  /** The state now, then again after each change, until `signal` aborts or the owner is released. */
  async *watch(owner: string, signal?: AbortSignal): AsyncGenerator<MurmurState> {
    this.assertOpen()
    await this.ready()
    this.assertOpen()
    await this.refresh()
    this.updateEngine()
    yield* this.watchers.stream(owner, () => this.state(), signal)
  }

  release(owner: string): void {
    this.watchers.release(owner)
  }

  /** Whether jobs can run: installed, on, and checked on a GPU. */
  private usable(): boolean {
    return (
      !this.closed &&
      !this.uninstalling &&
      this.installed() &&
      this.settings.murmurSettings().enabled &&
      this.settings.murmurCheck() !== null
    )
  }

  watchUsable(listener: (usable: boolean) => void): () => void {
    this.usableListeners.add(listener)
    listener(this.usable())
    return () => void this.usableListeners.delete(listener)
  }

  watchCleared(listener: () => void): () => void {
    this.clearedListeners.add(listener)
    return () => void this.clearedListeners.delete(listener)
  }

  private cleared(): void {
    for (const listener of this.clearedListeners) listener()
  }

  // What backing off and counting failures remembered is forgotten: after a passing check,
  // and when the person turns murmur on.
  private resetBackoff(): void {
    this.failures = 0
    this.engineStrikes = 0
    this.refusedUntil = 0
    this.refusals.clear()
    this.cached = undefined
    this.runtimeFailure = null
  }

  private changed(): void {
    this.watchers.changed()
    const usable = this.usable()
    if (usable === this.lastUsable) return
    this.lastUsable = usable
    // What stops being usable must not hold the GPU.
    if (!usable) {
      this.current?.abort()
      void this.server.stop()
      void this.preparer.stop()
    }
    for (const listener of this.usableListeners) listener(usable)
    this.wake()
  }

  /** Starts installing the engine and the model, whichever is missing; `settled` waits for the end. */
  async install(): Promise<void> {
    this.assertOpen()
    if (this.running) throw new DomainError("CONFLICT", "Murmur is already installing.")
    if (this.uninstalling)
      throw new DomainError("CONFLICT", "Murmur is being removed. Install it afterwards.")
    await this.refresh()
    // `refresh` yielded: the runner may have closed, or another install may have started.
    this.assertOpen()
    if (this.manifest === undefined) throw unavailable("Murmur is not available in this build.")
    if (this.running || this.uninstalling)
      throw new DomainError("CONFLICT", "Murmur is already installing.")
    const controller = new AbortController()
    this.updateFailedAt = undefined
    this.failure = null
    this.runtimeFailure = null
    this.settings.saveMurmurCheck(null)
    // Installing it says the person wants it, whatever they chose before; an off from then
    // on, during the install too, still holds.
    if (!this.installed()) this.settings.saveMurmurSettings({ enabled: null })
    this.installing = { step: "engine", received: 0, total: this.manifest.size }
    this.changed()
    this.running = { controller, done: this.run(this.manifest, controller.signal) }
  }

  /**
   * Fetches the engine of this build alone when murmur is on with its model but the engine
   * is an older one or missing, as after an update of the app.
   */
  private updateEngine(): void {
    const { manifest } = this
    if (
      this.closed ||
      this.running ||
      this.uninstalling ||
      (this.updateFailedAt !== undefined && this.clock() - this.updateFailedAt < updateRetryMs) ||
      this.engineReady ||
      manifest === undefined ||
      !this.settings.murmurSettings().enabled ||
      !this.modelReady
    )
      return
    const controller = new AbortController()
    this.failure = null
    this.installing = { step: "engine", received: 0, total: manifest.size }
    this.changed()
    this.running = { controller, done: this.run(manifest, controller.signal, true) }
  }

  /** Stops an install, and answers once it has. */
  async cancel(): Promise<void> {
    this.running?.controller.abort()
    await this.settled()
  }

  async settled(): Promise<void> {
    await this.running?.done
  }

  /** Removes the engine and the model, and turns murmur off by choice. */
  uninstall(): Promise<void> {
    this.assertOpen()
    if (this.uninstalling)
      return Promise.reject(new DomainError("CONFLICT", "Murmur is already being removed."))
    this.uninstalling = true
    // Kept, so closing waits for it instead of closing the store under it.
    this.removal = this.removeAll()
    return this.removal
  }

  private async removeAll(): Promise<void> {
    // The titles it wrote are cleared when it ends, or when it fails after turning murmur off.
    let turnedOff = false
    let removed = false
    try {
      await this.cancel()
      // The runner may have closed while the install ended.
      this.assertOpen()
      // Off first: a removal that fails halfway must not leave murmur on.
      turnedOff = this.settings.murmurSettings().enabled
      this.settings.saveMurmurSettings({ enabled: false })
      // As when the person turns it off: what was shown of failing jobs goes.
      this.runtimeFailure = null
      this.engineStrikes = 0
      this.changed()
      // The program is in use until it has exited, which Windows will not delete.
      await this.server.stop()
      try {
        await removeContents(this.directory)
      } catch (error) {
        throw new DomainError(
          "CONFLICT",
          `Murmur could not be removed: ${error instanceof Error ? error.message : String(error)}. Close anything using the files in ${this.directory} and try again.`,
        )
      } finally {
        await this.refresh()
      }
      this.settings.saveMurmurCheck(null)
      this.failure = null
      this.runtimeFailure = null
      removed = true
    } finally {
      this.uninstalling = false
      this.changed()
      if (!this.closed && (removed || turnedOff)) this.cleared()
    }
  }

  async set(change: MurmurSettingsChange): Promise<void> {
    this.assertOpen()
    await this.ready()
    this.assertOpen()
    if (this.uninstalling) throw new DomainError("CONFLICT", "Murmur is being removed.")
    const wasOn = this.settings.murmurSettings().enabled
    // Turned on before any install, it is wanted, and the install that follows turns it on.
    if (change.enabled === true && !this.installed())
      this.settings.saveMurmurSettings({ ...change, enabled: null })
    else this.settings.saveMurmurSettings(change)
    // A fresh start: what went wrong before is not held against it.
    if (change.enabled === true && !wasOn) this.resetBackoff()
    // Turned off, what was shown of failing jobs goes; the backoff stays until it is turned on.
    if (change.enabled === false && wasOn) {
      this.runtimeFailure = null
      this.engineStrikes = 0
    }
    this.changed()
    // Turned off by the person: the titles it wrote go.
    if (change.enabled === false && wasOn) this.cleared()
  }

  /** Cancels an install and ends the engine, as the runner closes. */
  async close(): Promise<void> {
    this.closed = true
    this.unwatchVoice?.()
    this.current?.abort()
    this.running?.controller.abort()
    this.wake()
    await this.settled()
    await this.removal?.catch(() => {})
    await this.loading
    await this.server.close()
    await this.preparer.close()
    this.watchers.finish()
  }

  private assertOpen(): void {
    if (this.closed) throw new DomainError("RUNTIME_CLOSING")
  }

  private modelPath(): string {
    return modelPathOf(this.directory, this.model)
  }

  private progress(install: MurmurInstall, force = false): void {
    this.installing = install
    this.watchers.progress(force)
  }

  private async run(manifest: Manifest, signal: AbortSignal, engineOnly = false): Promise<void> {
    const program = programFile("llama-server")
    try {
      signal.throwIfAborted()
      if (!(await exists(join(engineFolder(this.directory, manifest.sha256), program)))) {
        const total = manifest.size
        this.progress({ step: "engine", received: 0, total }, true)
        try {
          await fetchEngine({
            manifest,
            source: this.source,
            directory: this.directory,
            program,
            signal,
            progress: (received) => this.progress({ step: "engine", received, total }),
            // Unpacking removes the engines this one replaces; none may be running, and a
            // refresh must not bring one back until the new one is there.
            replacing: async () => {
              this.replacing = true
              this.swaps += 1
              this.engineDir = undefined
              this.changed()
              await this.server.stop()
            },
          })
        } finally {
          this.replacing = false
          this.swaps += 1
        }
        await this.refresh()
      }
      if (engineOnly) return
      // No GPU is found before the model, 1.28 GB, is downloaded for nothing.
      const folder = this.engineDir
      if (folder === undefined) throw new EngineError("The murmur engine is missing.")
      const devices = candidates(await this.listDevices(folder, signal))
      signal.throwIfAborted()
      if (devices.length === 0) throw new EngineError(needsGpu)
      await this.fetchModel(signal)
      this.progress({ step: "check", received: 0, total: 0 }, true)
      const check = await this.measure(signal, folder, devices)
      this.settings.saveMurmurCheck(check)
      this.resetBackoff()
      // Checked, so on, unless the person turned it off themselves.
      this.settings.saveMurmurSettings({ enabled: this.settings.murmurEnabledChoice() !== false })
      await this.refresh()
    } catch (error) {
      // Cancelling is the person's choice, not a failure.
      if (!signal.aborted && !aborted(error)) {
        this.failure = explain(error).slice(0, 1024)
        this.updateFailedAt = engineOnly ? this.clock() : undefined
      }
      // What finished stays: a model that downloaded is not downloaded again.
      await this.refresh().catch(() => {})
    } finally {
      this.installing = null
      this.running = undefined
      this.changed()
    }
  }

  private async fetchModel(signal: AbortSignal): Promise<void> {
    const total = this.model.size
    this.progress({ step: "model", received: 0, total }, true)
    if (!(await exists(this.modelPath()))) {
      await download({
        from: this.model.url,
        to: this.modelPath(),
        sha256: this.model.sha256,
        size: this.model.size,
        signal,
        progress: (received) => this.progress({ step: "model", received, total }),
      })
      await this.refresh()
    }
    // Models of an earlier pin, and downloads that never finished, are not kept.
    await pruneModels(this.directory, [this.modelPath()])
  }

  /**
   * The devices this engine sees; empty when `signal` aborts or it lists none. A program that
   * could not run, or failed, and lists none is an error that says why.
   */
  private async listDevices(folder: string, signal: AbortSignal): Promise<Device[]> {
    const program = join(folder, programFile("llama-server"))
    const run = await runEngineOnce(this.options.launch, program, ["--list-devices"], { signal })
    if (signal.aborted) return []
    const devices = parseDevices(`${run.stdout}\n${run.stderr}`)
    if (devices.length === 0 && (run.failure !== undefined || run.code !== 0)) {
      const last = run.stderr.split(/\r?\n/).findLast((text) => text.trim() !== "")
      const why = last?.trim() ?? run.failure ?? `it exited with code ${run.code}`
      throw new EngineError(`Murmur's engine could not list the GPUs: ${why.slice(0, 300)}`)
    }
    return devices
  }

  // A reply that is no usable title is no failure of the engine: that job gets no title.
  private async complete(
    config: Config,
    server: Server<Config, Facts>,
    chat: readonly Message[],
    signal: AbortSignal,
  ): Promise<Description | undefined> {
    const running = await this.started(server, config, signal)
    // A stuck engine must not hold every job behind it.
    const limit = AbortSignal.any([signal, AbortSignal.timeout(this.options.requestMs ?? 60_000)])
    const response = await server.request(running, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: chat,
        temperature: 0,
        max_tokens: 64,
        stream: false,
        response_format: responseFormat,
      }),
      signal: limit,
    })
    if (!response.ok)
      throw new EngineError(server.explain(running, `the engine answered ${response.status}`))
    server.touch(running)
    let body: { choices?: { message?: { content?: unknown } }[] } | undefined
    try {
      body = (await response.json()) as typeof body
    } catch (error) {
      // An answer cut off by the time limit is a stuck engine, as much as no answer.
      if (limit.aborted) throw error
    }
    const content = body?.choices?.[0]?.message?.content
    // The model is held to what it was shown: a title that copies an example is refused.
    return typeof content === "string"
      ? parseDescription(content, chat.findLast((message) => message.role === "user")?.content)
      : undefined
  }

  // The running server, started if need be: it takes no longer than `startMs` nor than the
  // job's own signal, so an engine that hangs while loading holds no one.
  private async started(
    server: Server<Config, Facts>,
    config: Config,
    signal: AbortSignal,
  ): Promise<Running<Facts>> {
    const bound = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.options.startMs ?? defaultStartMs),
    ])
    const acquiring = server.acquire(config)
    acquiring.catch(() => {})
    const expired = new Promise<never>((_, reject) => {
      const fail = () =>
        reject(
          signal.aborted
            ? signal.reason
            : new EngineError("Murmur's engine took too long to start."),
        )
      if (bound.aborted) fail()
      else bound.addEventListener("abort", fail, { once: true })
    })
    expired.catch(() => {})
    try {
      return await Promise.race([acquiring, expired])
    } catch (error) {
      // One that hung is ended; one that only lost its job carries on loading for the next.
      if (!signal.aborted) void server.stop()
      throw error
    }
  }

  /**
   * Runs the check description on each of `devices` in order, integrated first, and keeps
   * the first that gives a valid one. None is a failure that says murmur needs a working
   * GPU, and what the last device said. The test digest goes through the worker thread as
   * every digest does, so a worker that can't run fails the install, not the first job.
   */
  private async measure(
    signal: AbortSignal,
    folder: string,
    devices: readonly Device[],
  ): Promise<MurmurCheck> {
    const chat = await this.preparer.prepare(checkDigest, signal)
    signal.throwIfAborted()
    if (chat === undefined || typeof chat === "string")
      throw new EngineError(workerFailure[chat ?? "stopped"])
    let last: unknown
    for (const device of devices) {
      // Its own server, so a device that hangs or crashes ends with it.
      const server = this.makeServer(undefined)
      const timeoutMs = this.options.checkMs ?? 120_000
      const limit = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      const stop = () => void server.stop()
      limit.addEventListener("abort", stop, { once: true })
      try {
        const config = { folder, model: this.modelPath(), device: device.id }
        // The first run loads the model and warms up the GPU, which later jobs do not pay for.
        // eslint-disable-next-line no-await-in-loop -- One device at a time.
        if (!(await this.complete(config, server, chat, limit)))
          throw new EngineError("The model's reply was no usable title.")
        const started = performance.now()
        // eslint-disable-next-line no-await-in-loop -- One device at a time.
        if (!(await this.complete(config, server, chat, limit)))
          throw new EngineError("The model's reply was no usable title.")
        return {
          device: device.name.slice(0, 256),
          integrated: device.kind === "igpu",
          milliseconds: Math.round(performance.now() - started),
        }
      } catch (error) {
        // Cancelling ends the check; any other failure is this device's, and the next is tried.
        signal.throwIfAborted()
        last = error
      } finally {
        limit.removeEventListener("abort", stop)
        // eslint-disable-next-line no-await-in-loop -- One device at a time.
        await server.close()
      }
    }
    const cause = last instanceof Error ? ` ${last.message}`.slice(0, 700) : ""
    throw new EngineError(`${needsGpu} None of its GPUs described a test terminal.${cause}`)
  }

  // Waiting between jobs' looks at voice and memory: ends at once on a wake.
  private pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.sleepers.delete(done)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref()
      this.sleepers.add(done)
      signal?.addEventListener("abort", done, { once: true })
    })
  }

  private wake(): void {
    for (const sleeper of this.sleepers) sleeper()
  }

  async describe(
    digest: Digest,
    options: { readonly signal?: AbortSignal; readonly terminal: string },
  ): Promise<Description | null | undefined> {
    const { signal } = options
    if (signal?.aborted || !this.usable()) return undefined
    // Our turn ends when we do, but never before the one ahead of us has.
    const before = this.line
    let finish!: () => void
    const mine = new Promise<void>((resolve) => (finish = resolve))
    this.line = before.then(() => mine)
    // A job that is dropped leaves the line at once instead of waiting for its turn.
    const turn = await Promise.race([before.then(() => true), dropped(signal).then(() => false)])
    if (!turn) {
      finish()
      return undefined
    }
    try {
      return await this.job(digest, signal, options.terminal)
    } finally {
      finish()
    }
  }

  private async lowMemory(signal: AbortSignal | undefined): Promise<boolean> {
    const free = (await this.freeBytes(signal)) / mebibyte
    return free < (this.options.minFreeMiB ?? 2048)
  }

  private async freeBytes(signal: AbortSignal | undefined): Promise<number> {
    if (this.options.freeMemory) return this.options.freeMemory()
    if (process.platform !== "darwin") return freemem()
    const now = Date.now()
    if (this.memory && now - this.memory.at < 5000) return this.memory.bytes
    const bytes = await readVmStat(signal)
    // An aborted read says nothing of the memory: it is not kept.
    if (signal?.aborted) return Number.POSITIVE_INFINITY
    this.memory = { at: now, bytes }
    return bytes
  }

  private async job(
    digest: Digest,
    signal: AbortSignal | undefined,
    terminal: string,
  ): Promise<Description | null | undefined> {
    // Refusals are counted for the terminal asking.
    const key = JSON.stringify(["terminal", terminal])
    // A job that will be refused spends no time of the thread's.
    if (this.clock() < this.refusedUntil) return undefined
    if (this.clock() < (this.refusals.get(key)?.until ?? 0)) return undefined
    // Redacted and written in a thread of its own, within a deadline.
    const chat = await this.preparer.prepare(digest, signal)
    if (chat === undefined || typeof chat === "string") {
      // A job that was dropped, or came as murmur closed or turned off, did not fail.
      if (signal?.aborted || this.closed || !this.usable()) return undefined
      // A digest that took too long, or made the thread fail, is this terminal's trouble
      // (a screen that is slow to redact): only it is left alone, from the first time.
      if (chat === "late" || chat === "failed") this.refused(key, true, true)
      // A thread that would not start is everyone's: back off, and say so on the card.
      if (chat === "unavailable") {
        this.failed()
        this.runtimeFailure = "Murmur's worker could not start."
        this.changed()
      }
      return undefined
    }
    const retryMs = this.options.retryMs ?? 15_000
    for (;;) {
      if (signal?.aborted || !this.usable()) return undefined
      if (this.clock() < this.refusedUntil) return undefined
      // A terminal whose titles keep being refused is left alone for a while; the others aren't.
      if (this.clock() < (this.refusals.get(key)?.until ?? 0)) return undefined
      // Waits for voice to finish and for memory to come back, then looks again.
      // Murmur's own model counts in the computer's free memory once loaded: only a cold
      // start is held back by it.
      // eslint-disable-next-line no-await-in-loop -- One look at a time.
      const low = this.server.facts === undefined && (await this.lowMemory(signal))
      // Dropped while memory was read: an aborted read says nothing, and nothing may run.
      if (signal?.aborted) return undefined
      if (this.options.voice?.busy() || low) {
        // eslint-disable-next-line no-await-in-loop -- One look at a time.
        await this.pause(retryMs, signal)
        continue
      }
      if (signal?.aborted) return undefined
      const controller = new AbortController()
      this.current = controller
      const onAbort = () => controller.abort()
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        // eslint-disable-next-line no-await-in-loop -- One job at a time.
        const config = await this.configuration(controller.signal)
        // A voice that began while the devices were listed stopped this job; try again after it.
        if (controller.signal.aborted) {
          if (signal?.aborted) return undefined
          continue
        }
        if (config === "wait") {
          // eslint-disable-next-line no-await-in-loop -- One look at a time.
          await this.pause(retryMs, signal)
          continue
        }
        if (config === undefined) return undefined
        // eslint-disable-next-line no-await-in-loop -- One job at a time.
        const description = await this.complete(config, this.server, chat, controller.signal)
        this.failures = 0
        this.engineStrikes = 0
        if (this.runtimeFailure !== null) {
          this.runtimeFailure = null
          this.changed()
        }
        this.refused(key, description === undefined)
        return description ?? null
      } catch (error) {
        if (signal?.aborted || this.closed) return undefined
        // Stopped by voice, not by a failure: wait and run again.
        if (controller.signal.aborted) continue
        this.failed()
        // Three in a row are shown on the card, though the check stands.
        this.engineStrikes += 1
        if (this.engineStrikes >= 3) {
          this.runtimeFailure = (
            error instanceof EngineError ? error.message : "Murmur's engine stopped answering."
          ).slice(0, 1024)
          this.changed()
        }
        // An engine that failed, or stopped answering, starts afresh next time.
        void this.server.stop()
        return undefined
      } finally {
        signal?.removeEventListener("abort", onAbort)
        if (this.current === controller) this.current = undefined
      }
    }
  }

  // Counts the titles refused for a terminal in a row; from the second, like a failure, it is
  // not asked again for a while, longer each time. `severe` (its digest could not be
  // prepared) holds it off from the first.
  private refused(key: string, refused: boolean, severe = false): void {
    if (!refused) {
      this.refusals.delete(key)
      return
    }
    const count = (this.refusals.get(key)?.count ?? 0) + 1
    const wait =
      count < 2 && !severe
        ? 0
        : (this.options.backoffMs ?? 30_000) * 2 ** Math.min(count - (severe ? 1 : 2), 4)
    this.refusals.delete(key)
    this.refusals.set(key, { count, until: this.clock() + wait })
    // Bounded: the longest-quiet terminals are forgotten first.
    for (const old of this.refusals.keys()) {
      if (this.refusals.size <= 64) break
      this.refusals.delete(old)
    }
  }

  // A failed job refuses the next ones for a while, longer with each failure in a row.
  private failed(): void {
    this.failures += 1
    this.refusedUntil =
      this.clock() + (this.options.backoffMs ?? 30_000) * 2 ** Math.min(this.failures - 1, 4)
  }

  // What to run the server with: the checked GPU, found by name as indexes change; "wait"
  // when that GPU is short of memory to load the model into.
  private async configuration(signal: AbortSignal): Promise<Config | "wait" | undefined> {
    const folder = this.engineDir
    const check = this.settings.murmurCheck()
    if (folder === undefined || check === null) return undefined
    const model = this.modelPath()
    if (this.server.facts !== undefined && this.cached !== undefined)
      return { ...this.cached, folder, model }
    const listed = await this.listDevices(folder, signal)
    const device = listed.find((candidate) => candidate.name.slice(0, 256) === check.device)
    if (device === undefined) {
      if (signal.aborted) return undefined
      // The engine ran and lists no such GPU (a failure to list throws instead): that
      // check no longer stands.
      this.settings.saveMurmurCheck(null)
      this.failure = "The GPU murmur was checked on is gone. Try again."
      this.changed()
      return undefined
    }
    // Metal's figure is this process's own working set, which says nothing of the computer's.
    if (process.platform !== "darwin" && device.freeMiB < (this.options.minFreeMiB ?? 2048))
      return "wait"
    this.cached = { device: device.id }
    return { folder, model, device: device.id }
  }
}
