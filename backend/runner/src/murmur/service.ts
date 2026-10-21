import { execFile } from "node:child_process"
import { freemem } from "node:os"
import { dirname, join } from "node:path"

import type { MurmurCheck, MurmurInstall, MurmurSettings, MurmurState } from "@novadeck/protocol"
import { Versioned } from "@novadeck/wire/server"

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
import { DomainError } from "../errors.js"
import { logs } from "../log.js"
import type { MurmurSettingsChange, MurmurVerdict } from "../workspaces/store.js"
import type { Description, Describer, Digest, Gist, Input, Note, NoteDigest } from "./describer.js"
import { parseDescription, parseGist, sharesContentWord } from "./description.js"
import { candidates, parseDevices, type Device } from "./devices.js"
import { parseVmStat } from "./memory.js"
import { Preparer } from "./prepare.js"
import { formatOf, formats, type Message, type Task } from "./prompt.js"

/** Where the runner keeps murmur's settings. */
export type MurmurSettingsStore = {
  murmurSettings(): MurmurSettings
  saveMurmurSettings(settings: MurmurSettingsChange): void
  murmurEnabledChoice(): boolean | undefined
  /** The last install's check, which outlives a restart; `null` when none passed. */
  murmurCheck(): MurmurCheck | null
  saveMurmurCheck(check: MurmurCheck | null): void
  /** In how many sessions of the app the one-time offer was shown. */
  murmurOffers(): number
  saveMurmurOffers(offers: number): void
  /** Why an install found this computer can't run murmur; `null` when it never did. */
  murmurUnsupported(): MurmurVerdict | null
  saveMurmurUnsupported(verdict: MurmurVerdict | null): void
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
  /**
   * Whether the host saw only software rendering, so no graphics hardware: murmur is then
   * known not to run here, and nothing is downloaded. Unset when unsure.
   */
  readonly softwareGraphics?: boolean
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

// Why an install found that this computer can't run murmur, which a retry won't change:
// shown behind a details view, so it is technical. Only a real incompatibility is one: the
// engine ran and listed no device to use, or every device it was given answered with nothing
// usable. A timeout, an out-of-memory (another program may hold the video memory), a crash,
// a failed start or an error answer is an ordinary failure with Try again, and keeps the model.
class Unsupported extends EngineError {}

// A device ran the test and its reply was no usable title: the one failure of a device that
// says it can't run the model, as the others may pass at another time.
class Unusable extends EngineError {}

const softwareOnly = "This computer reports only software rendering; no graphics hardware answered."

const linuxHint =
  process.platform === "linux" ? " On Linux, check that a Vulkan driver is installed." : ""

// An exit that says a library the engine needs is not there: "error while loading shared
// libraries" or "cannot open shared object file" on Linux, STATUS_DLL_NOT_FOUND (0xC0000135)
// on Windows.
const missingLibrary = (
  run: { readonly code: number | null },
  printed: string | undefined,
): boolean =>
  run.code === 0xc0_00_01_35 ||
  /error while loading shared libraries|cannot open shared object file/i.test(printed ?? "")

const log = logs.for("murmur")

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
  stage: "forming",
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
// `engineInterface` in engines/murmur/scripts/build.ts, so an engine unpacked for the
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

// What each task makes, and the order the line serves them in: a gist is wanted soon, a title
// can wait.
type Made = { title: Description; gist: Gist }
const priority: Record<Task, number> = { gist: 0, title: 1 }
const parsers = { title: parseDescription, gist: parseGist } as const

// What the install check takes for a working device: a reply that is a JSON object with a
// title of at least two letters in a row, since a broken backend writes junk the grammar still
// closes. The check asks whether the engine runs the model and writes its reply in the format,
// not whether the title is one murmur would show: those rules change with the prompt, and a
// check that shared them failed on every machine when they did.
const parseCheck = (raw: string): Description | undefined => {
  try {
    const title = (JSON.parse(raw) as { title?: unknown } | null)?.title
    return typeof title === "string" && /\p{L}{2}/u.test(title)
      ? { title: title.trim(), changed: true }
      : undefined
  } catch {
    return undefined
  }
}

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

// How long the model stays loaded once nothing needs it.
const defaultIdleMs = 2 * 60 * 1000

// How often install progress reaches watchers, at most.
const progressMs = 100

/**
 * Murmur: the engine and model people install, the settings, and the describing of
 * terminals with them, on this machine's graphics and nowhere else. It gives way to voice
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
  private readonly watchers = new Versioned<MurmurState>({ throttleMs: progressMs })
  private readonly usableListeners = new Set<(usable: boolean) => void>()
  private readonly clearedListeners = new Set<() => void>()
  private lastUsable = false
  private closed = false
  // Jobs run one after another, never pre-empted: the one now running, and those waiting,
  // best priority first and in the order they came within a priority.
  private busy = false
  private readonly line: { readonly priority: number; readonly go: () => void }[] = []
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
  // Texts refused for a terminal in a row (per task), and until when it is not asked again.
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
      unsupported: this.unsupported(),
      offers: this.settings.murmurOffers(),
      failure: this.failure ?? this.runtimeFailure,
    }
  }

  // Why this computer can't run murmur, if the host or an install said so. An install's
  // verdict is of the engine build it ran: another build's engine gives it no weight.
  private unsupported(): MurmurState["unsupported"] {
    if (this.options.softwareGraphics) return { reason: softwareOnly, source: "host" }
    const verdict = this.settings.murmurUnsupported()
    return verdict !== null && verdict.engine === this.manifest?.sha256
      ? { reason: verdict.reason, source: "check" }
      : null
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
    if (this.options.softwareGraphics) throw unavailable("Murmur can't run on this computer.")
    if (this.running || this.uninstalling)
      throw new DomainError("CONFLICT", "Murmur is already installing.")
    // Installing again is how an install's verdict is asked anew: it stands until the new check
    // ends, passed (then it goes) or not.
    const controller = new AbortController()
    this.updateFailedAt = undefined
    this.failure = null
    this.runtimeFailure = null
    this.settings.saveMurmurCheck(null)
    // Installing it says the person wants it, whatever they chose before; an off from then
    // on, during the install too, still holds.
    if (!this.installed()) this.settings.saveMurmurSettings({ enabled: null })
    this.installing = { step: "engine", received: 0, total: this.manifest.size, origin: "person" }
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
    this.installing = { step: "engine", received: 0, total: manifest.size, origin: "update" }
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
        await this.whileReplacing(() => removeContents(this.directory))
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

  /** Counts a session of the app the one-time offer was shown in. */
  async noteOffered(): Promise<void> {
    this.assertOpen()
    await this.ready()
    this.assertOpen()
    this.settings.saveMurmurOffers(this.settings.murmurOffers() + 1)
    this.changed()
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
    if (this.closed) throw new DomainError("CLOSING")
  }

  private modelPath(): string {
    return modelPathOf(this.directory, this.model)
  }

  // What an install is doing now; who started it stays as it was.
  private progress(install: Omit<MurmurInstall, "origin">, force = false): void {
    this.installing = { ...install, origin: this.installing?.origin ?? "person" }
    this.watchers.progress(force)
  }

  // Runs `work`, which takes engine files away or puts them in place: a look at the disk that
  // spans it (a watch's refresh) is not believed, and cannot bring back what is going.
  private async whileReplacing<T>(work: () => Promise<T>): Promise<T> {
    this.replacing = true
    this.swaps += 1
    try {
      return await work()
    } finally {
      this.replacing = false
      this.swaps += 1
    }
  }

  private async run(manifest: Manifest, signal: AbortSignal, engineOnly = false): Promise<void> {
    const program = programFile("llama-server")
    try {
      signal.throwIfAborted()
      if (!(await exists(join(engineFolder(this.directory, manifest.sha256), program)))) {
        const total = manifest.size
        this.progress({ step: "engine", received: 0, total }, true)
        await this.whileReplacing(() =>
          fetchEngine({
            manifest,
            source: this.source,
            directory: this.directory,
            program,
            signal,
            progress: (received) => this.progress({ step: "engine", received, total }),
            // Unpacking removes the engines this one replaces; none may be running.
            replacing: async () => {
              this.engineDir = undefined
              this.changed()
              await this.server.stop()
            },
          }),
        )
        await this.refresh()
      }
      if (engineOnly) return
      // No device is found before the model, 1.28 GB, is downloaded for nothing.
      const folder = this.engineDir
      if (folder === undefined) throw new EngineError("The murmur engine is missing.")
      const devices = candidates(await this.listDevices(folder, signal))
      signal.throwIfAborted()
      if (devices.length === 0) throw new Unsupported(`No graphics device answered.${linuxHint}`)
      await this.fetchModel(signal)
      this.progress({ step: "check", received: 0, total: 0 }, true)
      const check = await this.measure(signal, folder, devices)
      this.settings.saveMurmurCheck(check)
      this.settings.saveMurmurUnsupported(null)
      this.resetBackoff()
      // Checked, so on, unless the person turned it off themselves.
      this.settings.saveMurmurSettings({ enabled: this.settings.murmurEnabledChoice() !== false })
      await this.refresh()
    } catch (error) {
      if (error instanceof Unsupported && !signal.aborted) await this.giveUp(error.message)
      // Cancelling is the person's choice, not a failure.
      else if (!signal.aborted && !aborted(error)) {
        this.failure = explain(error).slice(0, 1024)
        this.updateFailedAt = engineOnly ? this.clock() : undefined
        // The card shows it until the next try; the log keeps it after that.
        log.warn("murmur.install-failed", "Murmur's install failed.", {
          data: { reason: this.failure },
          err: error,
        })
      }
      // What finished stays: a model that downloaded is not downloaded again.
      await this.refresh().catch(() => {})
    } finally {
      this.installing = null
      this.running = undefined
      this.changed()
    }
  }

  // This computer can't run murmur: that is kept, and what the install downloaded goes, so
  // the person is offered nothing to try again.
  private async giveUp(reason: string): Promise<void> {
    this.settings.saveMurmurUnsupported({
      reason: reason.slice(0, 1024),
      engine: this.manifest?.sha256 ?? "",
    })
    this.settings.saveMurmurCheck(null)
    this.failure = null
    try {
      await this.whileReplacing(() => removeContents(this.directory))
    } catch {
      // Left behind, it only takes room; the verdict stands.
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
      const why = (last?.trim() ?? run.failure ?? `it exited with code ${run.code}`)
        .slice(0, 300)
        .replace(/\.+$/, "")
      // An engine that can't load a library it needs will fail the same way every time: that
      // is this computer's, with the hint. Any other failed start, or a timeout, is retried.
      if (missingLibrary(run, last))
        throw new Unsupported(`The engine could not list graphics devices: ${why}.${linuxHint}`)
      throw new EngineError(`The engine could not list graphics devices: ${why}.${linuxHint}`)
    }
    return devices
  }

  // A reply that is no usable text is no failure of the engine: that job gets none.
  private async complete<T extends Task>(
    config: Config,
    server: Server<Config, Facts>,
    chat: readonly Message[],
    signal: AbortSignal,
    task: T,
    input?: Input,
    parse?: (raw: string) => Made[T] | undefined,
  ): Promise<Made[T] | undefined> {
    const running = await this.started(server, config, signal)
    const format = input === undefined ? formats[task] : formatOf(task, input)
    // A stuck engine must not hold every job behind it.
    const limit = AbortSignal.any([signal, AbortSignal.timeout(this.options.requestMs ?? 60_000)])
    const response = await server.request(running, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: chat,
        temperature: 0,
        max_tokens: format.maxTokens,
        stream: false,
        response_format: format.responseFormat,
      }),
      signal: limit,
    })
    if (!response.ok) {
      // A request too big for the context is that job's, not the engine's: it gets no text,
      // and asking it again would be as big.
      if (
        response.status === 400 &&
        (await response.text()).includes("exceed_context_size_error")
      ) {
        server.touch(running)
        return undefined
      }
      throw new EngineError(server.explain(running, `the engine answered ${response.status}`))
    }
    server.touch(running)
    let body: { choices?: { message?: { content?: unknown } }[] } | undefined
    try {
      body = (await response.json()) as typeof body
    } catch (error) {
      // An answer cut off, by the time limit or by a crash, is the engine failing; it is never
      // a reply that said nothing usable, which is what can condemn a device.
      throw limit.aborted ? error : new EngineError("The engine's answer was cut off.")
    }
    const content = body?.choices?.[0]?.message?.content
    // The model is held to what it was shown: a text that copies an example is refused. A
    // title also loses the project's name, which the person sits in already.
    const project = input?.kind === "agent" || input?.kind === "shell" ? input.project : null
    if (typeof content === "string" && parse) return parse(content)
    return typeof content === "string"
      ? (parsers[task](
          content,
          chat.findLast((message) => message.role === "user")?.content,
          project,
        ) as Made[T] | undefined)
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
   * the first that gives a valid one. If every device answered with nothing usable this
   * computer can't run murmur (`Unsupported`); any other failure is an ordinary one. The test digest goes through the worker thread as
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
    let unusable = 0
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
        if (!(await this.complete(config, server, chat, limit, "title", checkDigest, parseCheck)))
          throw new Unusable("The model's reply was no usable title.")
        const started = performance.now()
        // eslint-disable-next-line no-await-in-loop -- One device at a time.
        if (!(await this.complete(config, server, chat, limit, "title", checkDigest, parseCheck)))
          throw new Unusable("The model's reply was no usable title.")
        return {
          device: device.name.slice(0, 256),
          integrated: device.kind === "igpu",
          milliseconds: Math.round(performance.now() - started),
        }
      } catch (error) {
        // Cancelling ends the check; any other failure is this device's, and the next is tried.
        signal.throwIfAborted()
        last = error
        if (error instanceof Unusable) unusable += 1
      } finally {
        limit.removeEventListener("abort", stop)
        // eslint-disable-next-line no-await-in-loop -- One device at a time.
        await server.close()
      }
    }
    const cause = last instanceof Error ? ` ${last.message}`.slice(0, 700) : ""
    // Every device answered, wrongly: this computer can't run it. Any other end (a timeout,
    // memory, a crash) leaves it a failure to try again.
    if (unusable === devices.length)
      throw new Unsupported(`No graphics device could run the model.${cause}`)
    throw new EngineError(`Murmur's test did not finish on this computer.${cause}`)
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
    const made = await this.write(digest, "title", options.signal, options.terminal)
    if (!made) return made
    // A shell is renamed on every command, and a first title has nothing to differ from.
    if (digest.kind === "shell" || digest.previous === null) return { ...made, changed: true }
    // A settled name is judged changed only when the model says so and the new title shares
    // no word with the old: the 2B model calls a sub-topic of the same work "different" often,
    // and its title then gives it away (see docs/murmur.md). A forming name is the model's call.
    if (digest.stage === "settled" && sharesContentWord(made.title, digest.previous.title))
      return { ...made, changed: false }
    return made
  }

  note(
    digest: NoteDigest,
    options: { readonly signal?: AbortSignal; readonly terminal: string },
  ): Promise<Note | null | undefined> {
    return this.write(digest, "gist", options.signal, options.terminal)
  }

  // Waits for the turn of `task` on the line, and runs the job.
  private async write<T extends Task>(
    input: Input,
    task: T,
    signal: AbortSignal | undefined,
    terminal: string,
  ): Promise<Made[T] | null | undefined> {
    if (signal?.aborted || !this.usable()) return undefined
    if (!(await this.wait(priority[task], signal))) return undefined
    try {
      return await this.job(input, task, signal, terminal)
    } finally {
      this.next()
    }
  }

  // Whether it is the job's turn: false when it was dropped while it waited, which leaves the
  // line at once instead of waiting for its turn.
  private async wait(rank: number, signal: AbortSignal | undefined): Promise<boolean> {
    if (!this.busy) {
      this.busy = true
      return true
    }
    let go!: () => void
    const turn = new Promise<void>((resolve) => (go = resolve))
    const place = { priority: rank, go }
    const at = this.line.findIndex((other) => other.priority > rank)
    this.line.splice(at === -1 ? this.line.length : at, 0, place)
    const mine = await Promise.race([turn.then(() => true), dropped(signal).then(() => false)])
    if (mine) return true
    // Dropped: out of the line, or, when its turn had just come, the turn passes on.
    const index = this.line.indexOf(place)
    if (index === -1) this.next()
    else this.line.splice(index, 1)
    return false
  }

  // The job ahead is done: the next in line goes, or the line is idle.
  private next(): void {
    const following = this.line.shift()
    if (following === undefined) this.busy = false
    else following.go()
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

  private async job<T extends Task>(
    input: Input,
    task: T,
    signal: AbortSignal | undefined,
    terminal: string,
  ): Promise<Made[T] | null | undefined> {
    // Refusals are counted for the terminal asking, and for each kind of text apart.
    const key = JSON.stringify([task, terminal])
    // A job that will be refused spends no time of the thread's.
    if (this.clock() < this.refusedUntil) return undefined
    if (this.clock() < (this.refusals.get(key)?.until ?? 0)) return undefined
    // Redacted and written in a thread of its own, within a deadline.
    const chat = await this.preparer.prepare(input, signal)
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
        log.warn("murmur.worker-unavailable", this.runtimeFailure)
        this.changed()
      }
      return undefined
    }
    const retryMs = this.options.retryMs ?? 15_000
    for (;;) {
      if (signal?.aborted || !this.usable()) return undefined
      if (this.clock() < this.refusedUntil) return undefined
      // A terminal whose texts keep being refused is left alone for a while; the others aren't.
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
        const made = await this.complete(config, this.server, chat, controller.signal, task, input)
        this.failures = 0
        this.engineStrikes = 0
        if (this.runtimeFailure !== null) {
          this.runtimeFailure = null
          this.changed()
        }
        this.refused(key, made === undefined)
        return made ?? null
      } catch (error) {
        if (signal?.aborted || this.closed) return undefined
        // Stopped by voice, not by a failure: wait and run again.
        if (controller.signal.aborted) continue
        this.failed()
        // Every failure is logged, as only the third in a row reaches the card; the line
        // carries what the engine last said, never the text it was asked about.
        log.warn("murmur.engine-failed", "Murmur's engine failed.", {
          data: { reason: error instanceof EngineError ? error.message : "no answer" },
          err: error,
        })
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

  // Counts the texts refused for a terminal in a row; from the second, like a failure, it is
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
      this.failure = "The graphics device murmur was checked on isn't there now."
      log.warn("murmur.device-missing", this.failure)
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
